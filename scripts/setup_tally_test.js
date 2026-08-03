// Setup Tally for Testing
// This script creates the necessary stock items and ledgers in Tally
// for testing. Run AFTER switching to local Tally config.
//
// Usage: node scripts/setup_tally_test.js
require('dotenv').config({ path: '.env' });
const tallyService = require('../src/services/tallyService');

const CONFIG = {
  stockItems: [
    { name: 'NOTEBOOK ASUS B1503CVAB-S76018', serial: 'TCNXCV08C442508', rate: 47033.90, category: 'Laptop' },
    { name: 'NOTEBOOK HP VICTUS 15-FA2191TX', serial: '5CD5391BXX', rate: 62287.29, category: 'Laptop' },
    { name: 'Test Laptop Dell Latitude 3420', serial: 'TEST-SN-001', rate: 35000, category: 'Laptop' },
    { name: 'Test Monitor Samsung 24"', serial: 'TEST-SN-002', rate: 12000, category: 'Monitor' },
  ],
  ledgers: [
    { name: 'Sales', parent: 'Sales Accounts' },
    { name: 'SALES @ 18%', parent: 'Sales Accounts' },
    { name: 'Output CGST @9%', parent: 'Duties & Taxes' },
    { name: 'Output SGST @9%', parent: 'Duties & Taxes' },
    { name: 'Purchase Asus', parent: 'Purchase Accounts' },
  ],
  supplier: 'Test Supplier - CRS',
};

function escapeXml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function createLedger(name, parent) {
  const cfg = tallyService.getTallyConfig();
  const xml = `<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Ledgers</REPORTNAME>
        <STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(cfg.company)}</SVCURRENTCOMPANY></STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${escapeXml(name)}" ACTION="Create">
            <NAME>${escapeXml(name)}</NAME>
            <PARENT>${escapeXml(parent)}</PARENT>
          </LEDGER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
  return await tallyService.rawHttpRequest(
    `http://${cfg.host}:${cfg.port}`, 'POST',
    { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }, xml
  );
}

async function createStockItem(name, category) {
  const cfg = tallyService.getTallyConfig();
  const xml = `<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Stock Items</REPORTNAME>
        <STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(cfg.company)}</SVCURRENTCOMPANY></STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <STOCKITEM NAME="${escapeXml(name)}" ACTION="Create">
            <NAME>${escapeXml(name)}</NAME>
            <PARENT>${escapeXml(category)}</PARENT>
            <BASEUNITS>Nos</BASEUNITS>
            <ISBATCHWISEON>Yes</ISBATCHWISEON>
            <ISSERIALNUMBERON>Yes</ISSERIALNUMBERON>
          </STOCKITEM>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
  return await tallyService.rawHttpRequest(
    `http://${cfg.host}:${cfg.port}`, 'POST',
    { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }, xml
  );
}

async function createPurchaseVoucher(stockName, serial, rate, date) {
  const cfg = tallyService.getTallyConfig();
  const supplier = CONFIG.supplier;
  const xml = `<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(cfg.company)}</SVCURRENTCOMPANY></STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${escapeXml(supplier)}" ACTION="Create">
            <NAME>${escapeXml(supplier)}</NAME>
            <PARENT>Sundry Creditors</PARENT>
          </LEDGER>
        </TALLYMESSAGE>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Purchase" ACTION="Create" OBJVIEW="Invoice Voucher View">
            <DATE>${date}</DATE>
            <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
            <VOUCHERNUMBER>CRS-PUR-${serial.substring(0, 8)}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>${escapeXml(supplier)}</PARTYLEDGERNAME>
            <NARRATION>Stock entry via CRS for ${escapeXml(serial)}</NARRATION>
            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>${escapeXml(stockName)}</STOCKITEMNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <RATE>${rate}/Nos</RATE>
              <AMOUNT>${rate}</AMOUNT>
              <ACTUALQTY>1 Nos</ACTUALQTY>
              <BILLEDQTY>1 Nos</BILLEDQTY>
              <BATCHALLOCATIONS.LIST>
                <BATCHNAME>Primary</BATCHNAME>
                <SERIALNUMBERLIST><SERIALNUMBER>${escapeXml(serial)}</SERIALNUMBER></SERIALNUMBERLIST>
                <AMOUNT>${rate}</AMOUNT>
                <ACTUALQTY>1 Nos</ACTUALQTY>
                <BILLEDQTY>1 Nos</BILLEDQTY>
              </BATCHALLOCATIONS.LIST>
            </ALLINVENTORYENTRIES.LIST>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${escapeXml(supplier)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${rate}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Purchase</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${rate}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
  return await tallyService.rawHttpRequest(
    `http://${cfg.host}:${cfg.port}`, 'POST',
    { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }, xml
  );
}

async function main() {
  console.log('=== Tally Test Setup ===\n');
  const cfg = tallyService.getTallyConfig();
  console.log(`Target Tally: ${cfg.host}:${cfg.port}, Company: "${cfg.company}"\n`);

  // Step 1: Test connection
  console.log('--- Step 1: Testing Tally connection ---');
  const ping = await tallyService.pingTally();
  if (!ping.reachable) {
    console.error('ERROR: Tally is not reachable at', `${cfg.host}:${cfg.port}`);
    console.error('Make sure Tally is running on this PC and Tally Server is configured.');
    console.error('In Tally: Gateway of Tally > F12 Configure > Tally Server Configuration > Start Tally Server');
    process.exit(1);
  }
  console.log('Tally is reachable!\n');

  // Step 2: Create ledgers
  console.log('--- Step 2: Creating/verifying ledgers ---');
  for (const ledger of CONFIG.ledgers) {
    try {
      const resp = await createLedger(ledger.name, ledger.parent);
      const hasError = resp.body.includes('LINEERROR');
      console.log(`  ${hasError ? 'SKIP' : 'OK'}: ${ledger.name} (${ledger.parent})`);
    } catch (err) {
      console.log(`  FAIL: ${ledger.name} - ${err.message}`);
    }
  }

  // Step 3: Create stock items
  console.log('\n--- Step 3: Creating/verifying stock items ---');
  for (const item of CONFIG.stockItems) {
    try {
      const resp = await createStockItem(item.name, item.category);
      const hasError = resp.body.includes('LINEERROR');
      console.log(`  ${hasError ? 'SKIP' : 'OK'}: ${item.name}`);
    } catch (err) {
      console.log(`  FAIL: ${item.name} - ${err.message}`);
    }
  }

  // Step 4: Create purchase vouchers (add stock with serial numbers)
  console.log('\n--- Step 4: Creating purchase vouchers (adding stock) ---');
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  for (const item of CONFIG.stockItems) {
    try {
      const resp = await createPurchaseVoucher(item.name, item.serial, item.rate, today);
      const created = (resp.body.match(/<CREATED>(\d+)<\/CREATED>/) || [])[1];
      if (parseInt(created) > 0) {
        console.log(`  ADDED: ${item.serial} -> ${item.name} (₹${item.rate})`);
      } else {
        const lineError = (resp.body.match(/<LINEERROR>(.*?)<\/LINEERROR>/) || [])[1] || 'unknown';
        console.log(`  SKIP: ${item.serial} - ${lineError}`);
      }
    } catch (err) {
      console.log(`  FAIL: ${item.serial} - ${err.message}`);
    }
  }

  console.log('\n=== Setup complete! ===');
  console.log('\nNow you can:');
  console.log('1. Start the CRS backend: npm start (from crs-backend/)');
  console.log('2. Start the CRS frontend: npm run dev (from project root)');
  console.log('3. Go to Inventory Module -> you should see test items');
  console.log('4. Create an Order with a test serial number');
  console.log('5. Go to Manage Orders -> Click "Generate Invoice"');
  console.log('6. The item should be marked as Sold in inventory');
  console.log('7. A Sales Voucher should be pushed to Tally');

  await tallyService.clearSerialCache();
  const serialMap = await tallyService.fetchStockSerialMap();
  console.log(`\nTally serial map: ${Object.keys(serialMap).length} entries`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
