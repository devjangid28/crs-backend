const { Client } = require('pg');
const decode = (s) => String(s ?? '')
  .replace(/&#(\d+);|&#x([0-9a-fA-F]+);/g, (m, dec, hex) => {
    const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp === 10 || cp === 13 || (cp < 32 && cp !== 9)) return ' ';
    try { return String.fromCodePoint(cp); } catch (e) { return m; }
  })
  .replace(/\s+/g, ' ').trim();
(async () => {
  const c = new Client({ host: 'localhost', port: 5432, user: 'postgres', password: 'BCCS@2026', database: 'bluechipcs' });
  await c.connect();

  const affected = await c.query("SELECT COUNT(*)::int AS n FROM customers WHERE name ~ '[&#\u0001-\u001F]' OR name LIKE '%  %' OR name <> btrim(name)");
  console.log('customers with weird names:', affected.rows[0].n);
  const aff2 = await c.query("SELECT COUNT(*)::int AS n FROM tally_sales WHERE party_name ~ '[&#\u0001-\u001F]' OR party_name <> btrim(party_name)");
  console.log('tally_sales with weird party_name:', aff2.rows[0].n);

  for (const col of ['name', 'address', 'city', 'state']) {
    const r = await c.query(`SELECT COUNT(*)::int AS n FROM customers WHERE ${col} ~ '[&#\u0001-\u001F]'`);
    if (r.rows[0].n > 0) console.log(`  customers.${col} with entities/control chars:`, r.rows[0].n);
  }
  // per-row update using decode
  const rows = await c.query("SELECT id, name, address, city, state FROM customers WHERE name ~ '[&#\u0001-\u001F]' OR name LIKE '%  %' OR name <> btrim(name) OR address ~ '[&#\u0001-\u001F]'");
  console.log('rows to fix:', rows.rowCount);
  let changed = 0;
  for (const r of rows.rows) {
    const nn = decode(r.name), na = decode(r.address), nc = decode(r.city), ns = decode(r.state);
    if (nn !== r.name || na !== r.address || nc !== r.city || ns !== r.state) {
      await c.query('UPDATE customers SET name=$2, address=$3, city=$4, state=$5, updated_at=CURRENT_TIMESTAMP WHERE id=$1',
        [r.id, nn, na, nc, ns]);
      changed++;
    }
  }
  console.log('customers updated:', changed);

  const sr = await c.query("SELECT id, party_name FROM tally_sales WHERE party_name ~ '[&#\u0001-\u001F]' OR party_name <> btrim(party_name)");
  console.log('tally_sales rows to fix:', sr.rowCount);
  let sch = 0;
  for (const r of sr.rows) {
    const pn = decode(r.party_name);
    if (pn !== r.party_name) { await c.query('UPDATE tally_sales SET party_name=$2 WHERE id=$1', [r.id, pn]); sch++; }
  }
  console.log('tally_sales updated:', sch);

  const chk = await c.query("SELECT id, name FROM customers WHERE id IN (2238)");
  for (const r of chk.rows) console.log('after:', r.id, JSON.stringify(r.name));
  await c.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
