const { Pool } = require('pg');
require('dotenv').config({ path: __dirname + '/.env' });

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'BCCS@2026',
  database: process.env.DB_NAME || 'bluechipcs',
});

const TEST_PHONES = ['9998245013', '9099128072', '9974794228', '9016806113'];

const TEST_NAME_ILIKE = [
  'Dev jangid%', 'Vishu Jangid%', 'vishu jangid%', 'dev jangid%',
  '%deepka%', '%uthkarsh%',
  '%test user%', '%test send%', '%test whatsapp%',
  'Verify Test%', 'Final Test%', 'Test Customer%',
  '%sdf%', '%ankit ff%', '%ankit dd%', '%rahul soi%',
];

const EXACT_TEST_NAMES = ['a', 'b', 'test', 'test user', 'dev', 'dipak', 'vishu'];

// Customers to NEVER delete (real staff users)
const PROTECTED_PHONES = ['9099128072', '9998245013'];

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

function log(msg) { console.log('[CLEANUP] ' + msg); }
function logV(msg) { if (VERBOSE) console.log('  ' + msg); }

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    log('Mode: ' + (DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE RUN'));
    log('** users table will NEVER be touched **');
    log('');

    // STEP 1: Find test customers
    log('STEP 1: Finding test customers...');
    const custByPhone = await client.query(
      'SELECT id, name, phone FROM customers WHERE phone = ANY($1) OR phone2 = ANY($1) OR whatsapp_number = ANY($1)',
      [TEST_PHONES]
    );
    log('  By phone: ' + custByPhone.rows.length);
    custByPhone.rows.forEach(function(r) { logV('    [' + r.id + '] ' + r.name + ' | ' + r.phone); });

    const ilikeConds = TEST_NAME_ILIKE.map(function(_, i) { return 'name ILIKE $' + (i + 1); }).join(' OR ');
    const custByName = await client.query(
      'SELECT id, name, phone FROM customers WHERE ' + ilikeConds,
      TEST_NAME_ILIKE
    );
    log('  By name pattern: ' + custByName.rows.length);
    custByName.rows.forEach(function(r) { logV('    [' + r.id + '] ' + r.name + ' | ' + r.phone); });

    const custByExact = await client.query(
      'SELECT id, name, phone FROM customers WHERE LOWER(name) = ANY($1)',
      [EXACT_TEST_NAMES.map(function(n) { return n.toLowerCase(); })]
    );
    log('  By exact name: ' + custByExact.rows.length);
    custByExact.rows.forEach(function(r) { logV('    [' + r.id + '] ' + r.name + ' | ' + r.phone); });

    var allCustIds = Array.from(new Set(
      custByPhone.rows.map(function(r) { return r.id; })
        .concat(custByName.rows.map(function(r) { return r.id; }))
        .concat(custByExact.rows.map(function(r) { return r.id; }))
    ));
    // Protect real staff users - don't delete their customer records
    var protectedRows = await client.query(
      'SELECT id FROM customers WHERE phone = ANY($1)',
      [PROTECTED_PHONES]
    );
    var protectedIds = new Set(protectedRows.rows.map(function(r) { return r.id; }));
    var customerIds = allCustIds.filter(function(id) { return !protectedIds.has(id); });
    log('  Staff users kept as customers: ' + protectedIds.size);
    log('  Will delete: ' + customerIds.length + ' customers');
    log('');

    // STEP 2: Find test tickets
    log('STEP 2: Finding test tickets...');
    var tParams = []; var ti = 1; var tConds = [];
    if (customerIds.length > 0) { tConds.push('customer_id = ANY($' + ti++ + ')'); tParams.push(customerIds); }
    tConds.push('customer_phone = ANY($' + ti++ + ')'); tParams.push(TEST_PHONES);
    TEST_NAME_ILIKE.forEach(function(pat) { tConds.push('customer_name ILIKE $' + ti++); tParams.push(pat); });
    tConds.push('LOWER(customer_name) = ANY($' + ti++ + ')'); tParams.push(EXACT_TEST_NAMES.map(function(n) { return n.toLowerCase(); }));

    const tickets = await client.query('SELECT id, ticket_id, customer_name, customer_phone FROM tickets WHERE ' + tConds.join(' OR '), tParams);
    const ticketIds = tickets.rows.map(function(r) { return r.id; });
    log('  Found: ' + tickets.rows.length + ' tickets');
    tickets.rows.forEach(function(r) { logV('    [' + r.id + '] ' + r.ticket_id + ' | ' + r.customer_name + ' | ' + r.customer_phone); });
    log('');

    // STEP 3: Find test orders
    log('STEP 3: Finding test orders...');
    var oParams = []; var oi = 1; var oConds = [];
    oConds.push('mobile_number = ANY($' + oi++ + ')'); oParams.push(TEST_PHONES);
    TEST_NAME_ILIKE.forEach(function(pat) { oConds.push('customer_name ILIKE $' + oi++); oParams.push(pat); });
    oConds.push('LOWER(customer_name) = ANY($' + oi++ + ')'); oParams.push(EXACT_TEST_NAMES.map(function(n) { return n.toLowerCase(); }));

    const orders = await client.query('SELECT id, order_number, customer_name, mobile_number FROM orders WHERE ' + oConds.join(' OR '), oParams);
    const orderIds = orders.rows.map(function(r) { return r.id; });
    log('  Found: ' + orders.rows.length + ' orders');
    orders.rows.forEach(function(r) { logV('    [' + r.id + '] ' + r.order_number + ' | ' + r.customer_name + ' | ' + r.mobile_number); });
    log('');

    // STEP 4: Find test messages
    log('STEP 4: Finding test messages...');
    var mParams = []; var mi = 1; var mConds = [];
    TEST_PHONES.forEach(function(phone) { mConds.push('conversation_id ILIKE $' + mi++); mParams.push('%' + phone + '%'); });
    mConds.push('phone = ANY($' + mi++ + ')'); mParams.push(TEST_PHONES);
    TEST_NAME_ILIKE.forEach(function(pat) { mConds.push('(sender ILIKE $' + mi + ' OR receiver ILIKE $' + mi + ')'); mParams.push(pat); mi++; });
    if (ticketIds.length > 0) { mConds.push('ticket_id = ANY($' + mi++ + ')'); mParams.push(ticketIds); }
    if (orderIds.length > 0) { mConds.push('order_id = ANY($' + mi++ + ')'); mParams.push(orderIds); }
    if (customerIds.length > 0) { mConds.push('customer_id = ANY($' + mi++ + ')'); mParams.push(customerIds); }

    const messages = await client.query('SELECT id FROM messages WHERE ' + mConds.join(' OR '), mParams);
    const messageIds = messages.rows.map(function(r) { return r.id; });
    log('  Found: ' + messages.rows.length + ' messages');
    log('');

    // STEP 5: Find related records
    log('STEP 5: Finding related records...');
    var invConds = []; var invParams = []; var vi = 1;
    if (ticketIds.length > 0) { invConds.push('ticket_id = ANY($' + vi++ + ')'); invParams.push(ticketIds); }
    if (orderIds.length > 0) { invConds.push('order_id = ANY($' + vi++ + ')'); invParams.push(orderIds); }
    if (customerIds.length > 0) { invConds.push('customer_id = ANY($' + vi++ + ')'); invParams.push(customerIds); }
    invConds.push('customer_phone = ANY($' + vi++ + ')'); invParams.push(TEST_PHONES);
    TEST_NAME_ILIKE.forEach(function(pat) { invConds.push('customer_name ILIKE $' + vi++); invParams.push(pat); });
    const invoices = await client.query('SELECT id FROM invoices WHERE ' + invConds.join(' OR '), invParams);
    const invoiceIds = invoices.rows.map(function(r) { return r.id; });
    log('  Invoices: ' + invoiceIds.length);

    var payConds = []; var payParams = []; var pi = 1;
    if (ticketIds.length > 0) { payConds.push('ticket_id = ANY($' + pi++ + ')'); payParams.push(ticketIds); }
    if (invoiceIds.length > 0) { payConds.push('invoice_id = ANY($' + pi++ + ')'); payParams.push(invoiceIds); }
    var payments = payConds.length > 0 ? await client.query('SELECT id FROM payment_history WHERE ' + payConds.join(' OR '), payParams) : { rows: [] };
    var paymentIds = payments.rows.map(function(r) { return r.id; });
    log('  Payment records: ' + paymentIds.length);

    var apptConds = []; var apptParams = []; var ai = 1;
    if (ticketIds.length > 0) { apptConds.push('ticket_id = ANY($' + ai++ + ')'); apptParams.push(ticketIds); }
    if (customerIds.length > 0) { apptConds.push('customer_id = ANY($' + ai++ + ')'); apptParams.push(customerIds); }
    var appts = apptConds.length > 0 ? await client.query('SELECT id FROM appointments WHERE ' + apptConds.join(' OR '), apptParams) : { rows: [] };
    log('  Appointments: ' + appts.rows.length);

    var csatConds = []; var csatParams = []; var ci = 1;
    if (ticketIds.length > 0) { csatConds.push('ticket_id = ANY($' + ci++ + ')'); csatParams.push(ticketIds); }
    if (customerIds.length > 0) { csatConds.push('customer_id = ANY($' + ci++ + ')'); csatParams.push(customerIds); }
    var csat = csatConds.length > 0 ? await client.query('SELECT id FROM customer_satisfaction WHERE ' + csatConds.join(' OR '), csatParams) : { rows: [] };
    log('  Satisfaction: ' + csat.rows.length);

    var quotConds = []; var quotParams = []; var qi = 1;
    if (customerIds.length > 0) { quotConds.push('customer_id = ANY($' + qi++ + ')'); quotParams.push(customerIds); }
    quotConds.push('customer_phone = ANY($' + qi++ + ')'); quotParams.push(TEST_PHONES);
    TEST_NAME_ILIKE.forEach(function(pat) { quotConds.push('customer_name ILIKE $' + qi++); quotParams.push(pat); });
    var quots = await client.query('SELECT id FROM quotations WHERE ' + quotConds.join(' OR '), quotParams);
    log('  Quotations: ' + quots.rows.length);

    var amcConds = []; var amcParams = []; var amci = 1;
    if (customerIds.length > 0) { amcConds.push('customer_id = ANY($' + amci++ + ')'); amcParams.push(customerIds); }
    amcConds.push('mobile = ANY($' + amci++ + ')'); amcParams.push(TEST_PHONES);
    var amcs = await client.query('SELECT id FROM amc_contracts WHERE ' + amcConds.join(' OR '), amcParams);
    var amcContractIds = amcs.rows.map(function(r) { return r.id; });
    log('  AMC contracts: ' + amcContractIds.length);
    log('');

    // STEP 6: Execute deletions
    log('STEP 6: Executing deletions...');

    if (DRY_RUN) {
      log('  *** DRY RUN - No changes will be made ***');
      log('');
      log('  Summary:');
      log('    Customers: ' + customerIds.length);
      log('    Tickets: ' + ticketIds.length);
      log('    Orders: ' + orderIds.length);
      log('    Messages: ' + messageIds.length);
      log('    Invoices: ' + invoiceIds.length);
      log('    Payments: ' + paymentIds.length);
      log('    Appointments: ' + appts.rows.length);
      log('    Satisfaction: ' + csat.rows.length);
      log('    Quotations: ' + quots.rows.length);
      log('    AMC contracts: ' + amcContractIds.length);
      log('');
      log('  ** users table NOT touched **');
      log('  Run without --dry-run to execute.');
      await client.query('ROLLBACK');
      return;
    }

    // FK-safe deletion order
    if (invoiceIds.length > 0) {
      var r1 = await client.query('DELETE FROM invoice_items WHERE invoice_id = ANY($1)', [invoiceIds]);
      log('  Deleted ' + r1.rowCount + ' invoice_items');
    }
    if (paymentIds.length > 0) {
      var r2 = await client.query('DELETE FROM payment_history WHERE id = ANY($1)', [paymentIds]);
      log('  Deleted ' + r2.rowCount + ' payment_history');
    }
    if (ticketIds.length > 0) {
      var r3 = await client.query('DELETE FROM payment_history WHERE ticket_id = ANY($1)', [ticketIds]);
      log('  Deleted ' + r3.rowCount + ' payment_history (by ticket)');
    }
    if (invoiceIds.length > 0) {
      var r4 = await client.query('DELETE FROM invoices WHERE id = ANY($1)', [invoiceIds]);
      log('  Deleted ' + r4.rowCount + ' invoices');
    }
    if (ticketIds.length > 0) {
      var r5 = await client.query('DELETE FROM invoices WHERE ticket_id = ANY($1)', [ticketIds]);
      log('  Deleted ' + r5.rowCount + ' invoices (by ticket)');
    }
    if (ticketIds.length > 0) {
      await client.query('DELETE FROM customer_satisfaction WHERE ticket_id = ANY($1)', [ticketIds]);
    }
    if (customerIds.length > 0) {
      var r6 = await client.query('DELETE FROM customer_satisfaction WHERE customer_id = ANY($1)', [customerIds]);
      log('  Deleted ' + r6.rowCount + ' satisfaction');
    }
    if (amcContractIds.length > 0) {
      await client.query('DELETE FROM amc_visit_images WHERE visit_id IN (SELECT id FROM amc_visits WHERE contract_id = ANY($1))', [amcContractIds]);
      var r7 = await client.query('DELETE FROM amc_visits WHERE contract_id = ANY($1)', [amcContractIds]);
      log('  Deleted ' + r7.rowCount + ' AMC visits');
      var r8 = await client.query('DELETE FROM amc_issues WHERE contract_id = ANY($1)', [amcContractIds]);
      log('  Deleted ' + r8.rowCount + ' AMC issues');
      var r9 = await client.query('DELETE FROM amc_timeline WHERE contract_id = ANY($1)', [amcContractIds]);
      log('  Deleted ' + r9.rowCount + ' AMC timeline');
      var r10 = await client.query('DELETE FROM amc_contracts WHERE id = ANY($1)', [amcContractIds]);
      log('  Deleted ' + r10.rowCount + ' AMC contracts');
    }
    if (quots.rows.length > 0) {
      var qIds = quots.rows.map(function(r) { return r.id; });
      var r11 = await client.query('DELETE FROM quotations WHERE id = ANY($1)', [qIds]);
      log('  Deleted ' + r11.rowCount + ' quotations');
    }
    if (appts.rows.length > 0) {
      var aIds = appts.rows.map(function(r) { return r.id; });
      var r12 = await client.query('DELETE FROM appointments WHERE id = ANY($1)', [aIds]);
      log('  Deleted ' + r12.rowCount + ' appointments');
    }
    if (ticketIds.length > 0) {
      var r13 = await client.query('DELETE FROM attachments WHERE ticket_id = ANY($1)', [ticketIds]);
      log('  Deleted ' + r13.rowCount + ' attachments');
      var r14 = await client.query('DELETE FROM notes WHERE ticket_id = ANY($1)', [ticketIds]);
      log('  Deleted ' + r14.rowCount + ' notes');
      var r15 = await client.query('DELETE FROM ticket_status_history WHERE ticket_id = ANY($1)', [ticketIds]);
      log('  Deleted ' + r15.rowCount + ' status history');
    }
    if (orderIds.length > 0) {
      var r16 = await client.query('DELETE FROM order_components WHERE order_id = ANY($1)', [orderIds]);
      log('  Deleted ' + r16.rowCount + ' order components');
    }
    if (messageIds.length > 0) {
      var r17 = await client.query('DELETE FROM messages WHERE id = ANY($1)', [messageIds]);
      log('  Deleted ' + r17.rowCount + ' messages');
    }
    if (orderIds.length > 0) {
      var r18 = await client.query('DELETE FROM orders WHERE id = ANY($1)', [orderIds]);
      log('  Deleted ' + r18.rowCount + ' orders');
    }
    if (ticketIds.length > 0) {
      var r19 = await client.query('DELETE FROM tickets WHERE id = ANY($1)', [ticketIds]);
      log('  Deleted ' + r19.rowCount + ' tickets');
    }
    if (customerIds.length > 0) {
      var r20 = await client.query('DELETE FROM customers WHERE id = ANY($1)', [customerIds]);
      log('  Deleted ' + r20.rowCount + ' customers');
    }

    await client.query('COMMIT');
    log('');
    log('DONE! All test data removed.');
    log('** users table was NOT touched - all staff accounts intact **');

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[ERROR] Failed:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(function() { process.exit(1); });
