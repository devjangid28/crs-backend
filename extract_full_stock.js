require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) =>
    ['VOUCHER', 'BATCHALLOCATIONS.LIST', 'ALLLEDGERENTRIES.LIST',
     'ALLINVENTORYENTRIES.LIST', 'SERIALNUMBERLIST', 'SERIALNUMBER',
     'STOCKITEM', 'BATCH', 'COLLECTION'].includes(name),
});

const company = process.env.TALLY_COMPANY || 'BLUECHIP COMPUTER SYSTEM - 2024-25';
const url = `http://${process.env.TALLY_HOST || '192.168.2.19'}:${process.env.TALLY_PORT || 9000}`;

async function post(xml, timeout = 60000) {
  const r = await t.rawHttpRequest(url, 'POST', {
    'Content-Type': 'text/xml',
    'Content-Length': Buffer.byteLength(xml),
  }, xml, timeout);
  return r.body;
}

// ============ 1. Stock Query: closing balances per stock item ============
function buildStockQueryXml() {
  return `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Stock Query</REPORTNAME>
        <STATICVARIABLES>
          <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
          <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
          <SVINCLUDEBATCHES>Yes</SVINCLUDEBATCHES>
          <SVSHOWITEMWISERATE>Yes</SVSHOWITEMWISERATE>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;
}

// ============ 2. Stock Item master collection: batches + serials + rate ============
function buildStockItemsRequest() {
  return `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CRSFullStock</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CRSFullStock" ISINITIALIZE="Yes">
            <TYPE>StockItem</TYPE>
            <NATIVEMETHOD>Name</NATIVEMETHOD>
            <NATIVEMETHOD>Parent</NATIVEMETHOD>
            <NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>
            <NATIVEMETHOD>BaseUnits</NATIVEMETHOD>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

async function main() {
  console.log(`Company: ${company}`);
  console.log(`URL: ${url}`);

  // ---- Part 1: Stock Query ----
  console.log('\n=== Fetching Stock Query (closing balances) ===');
  const stockXml = buildStockQueryXml();
  let stockBody = '';
  try {
    stockBody = await post(stockXml);
    fs.writeFileSync('./extract_stock_query.xml', stockBody);
    console.log('Stock Query saved, size:', stockBody.length);
  } catch (e) {
    console.error('Stock Query failed:', e.message);
  }

  // ---- Part 2: Stock item masters ----
  console.log('\n=== Fetching Stock Item masters ===');
  const masterXml = buildStockItemsRequest();
  let masterBody = '';
  try {
    masterBody = await post(masterXml);
    fs.writeFileSync('./extract_stock_masters.xml', masterBody);
    console.log('Stock masters saved, size:', masterBody.length);
  } catch (e) {
    console.error('Stock masters failed:', e.message);
  }

  // ---- Parse Stock Query into items with closing balances ----
  const stockItems = new Map(); // name -> { name, closingQty, openingQty, inQty, outQty }
  try {
    const parsed = parser.parse(stockBody);
    const body = parsed?.ENVELOPE?.BODY;
    let messages = body?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE || body?.DATA?.TALLYMESSAGE;
    const msgArr = Array.isArray(messages) ? messages : [messages];
    let count = 0;
    for (const msg of msgArr) {
      const rows = msg?.STOCKITEM;
      if (!rows) continue;
      const rowArr = Array.isArray(rows) ? rows : [rows];
      for (const item of rowArr) {
        const name = (item?.NAME || item?.['@_NAME'] || '').trim();
        if (!name) continue;
        stockItems.set(name, {
          name,
          closingQty: parseFloat(String(item?.CLOSINGBALANCE ?? item?.CLOSINGQTY ?? '')).toString(),
          openingQty: parseFloat(String(item?.OPENINGBALANCE ?? item?.OPENINGQTY ?? '')).toString(),
        });
        count++;
      }
    }
    console.log(`Stock Query items parsed: ${count}`);
  } catch (e) {
    console.error('Stock Query parse error:', e.message);
  }

  // ---- Parse Stock masters for serials within batches ----
  const serialMap = new Map(); // serial -> { stockItem, batch, rate }
  const stockSerialCount = new Map(); // stockItem -> count of serials
  try {
    const parsed = parser.parse(masterBody);
    const body = parsed?.ENVELOPE?.BODY?.DATA;
    let collections = body?.COLLECTION;
    if (!collections) {
      // fallback to TALLYMESSAGE structure
      const fb = parser.parse(masterBody);
      const fbBody = fb?.ENVELOPE?.BODY;
      const msgs = fbBody?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE || fbBody?.DATA?.TALLYMESSAGE;
      const msgArr2 = Array.isArray(msgs) ? msgs : [msgs];
      let cnt = 0;
      for (const msg of msgArr2) {
        const items = msg?.STOCKITEM;
        if (!items) continue;
        const arr = Array.isArray(items) ? items : [items];
        for (const it of arr) {
          const name = (it?.NAME || it?.['@_NAME'] || '').trim();
          if (!name) continue;
          const batches = it?.['BATCHALLOCATIONS.LIST'] || it?.BATCHALLOCATIONS?.LIST || [];
          const bArr = Array.isArray(batches) ? batches : [batches];
          for (const b of bArr) {
            const serialNos = b?.SERIALNUMBERLIST?.SERIALNUMBER || [];
            const sArr = Array.isArray(serialNos) ? serialNos : [serialNos];
            for (const s of sArr) {
              const sn = (typeof s === 'string' ? s : s?.['#text'] || '').trim();
              if (sn) {
                if (!serialMap.has(sn)) serialMap.set(sn, { stockItem: name, batch: b?.BATCHNAME || '', rate: b?.RATE || '' });
                stockSerialCount.set(name, (stockSerialCount.get(name) || 0) + 1);
                cnt++;
              }
            }
            const batchName = (b?.BATCHNAME || '').trim();
            if (batchName && batchName !== 'Primary' && !/^Primary\s*Batch$/i.test(batchName) && !serialMap.has(batchName)) {
              serialMap.set(batchName, { stockItem: name, batch: batchName, rate: b?.RATE || '' });
              stockSerialCount.set(name, (stockSerialCount.get(name) || 0) + 1);
              cnt++;
            }
          }
        }
      }
      console.log(`Stock masters serials parsed (fallback): ${cnt}`);
    } else {
      const collArr = Array.isArray(collections) ? collections : [collections];
      let cnt = 0;
      for (const coll of collArr) {
        const items = coll?.STOCKITEM;
        if (!items) continue;
        const arr = Array.isArray(items) ? items : [items];
        for (const it of arr) {
          const name = (it?.NAME || it?.['@_NAME'] || '').trim();
          if (!name) continue;
          const batches = it?.['BATCHALLOCATIONS.LIST'] || it?.BATCHALLOCATIONS?.LIST || [];
          const bArr = Array.isArray(batches) ? batches : [batches];
          for (const b of bArr) {
            const serialNos = b?.SERIALNUMBERLIST?.SERIALNUMBER || [];
            const sArr = Array.isArray(serialNos) ? serialNos : [serialNos];
            for (const s of sArr) {
              const sn = (typeof s === 'string' ? s : s?.['#text'] || '').trim();
              if (sn) {
                if (!serialMap.has(sn)) serialMap.set(sn, { stockItem: name, batch: b?.BATCHNAME || '', rate: b?.RATE || '' });
                stockSerialCount.set(name, (stockSerialCount.get(name) || 0) + 1);
                cnt++;
              }
            }
            const batchName = (b?.BATCHNAME || '').trim();
            if (batchName && batchName !== 'Primary' && !/^Primary\s*Batch$/i.test(batchName) && !serialMap.has(batchName)) {
              serialMap.set(batchName, { stockItem: name, batch: batchName, rate: b?.RATE || '' });
              stockSerialCount.set(name, (stockSerialCount.get(name) || 0) + 1);
              cnt++;
            }
          }
        }
      }
      console.log(`Stock masters serials parsed: ${cnt}`);
    }
  } catch (e) {
    console.error('Stock masters parse error:', e.message);
  }

  // ---- Combine ----
  const finalItems = [];
  for (const [name, info] of stockItems) {
    const serials = [...serialMap.keys()].filter(s => serialMap.get(s).stockItem === name);
    const closingQty = parseFloat(info.closingQty);
    finalItems.push({
      name,
      closingQty,
      serialCount: serials.length,
      serials,
    });
  }

  // Items that have serials but weren't in stock query
  for (const [sn, info] of serialMap) {
    if (!stockItems.has(info.stockItem)) {
      finalItems.push({
        name: info.stockItem,
        closingQty: null,
        serialCount: 1,
        serials: [sn],
      });
    }
  }

  fs.writeFileSync('./extract_stock_result.json', JSON.stringify({
    company,
    fetchedAt: new Date().toISOString(),
    stockItemCount: stockItems.size,
    serialCount: serialMap.size,
    items: finalItems,
  }, null, 2));

  console.log('\n=== SUMMARY ===');
  console.log(`Total stock items: ${stockItems.size}`);
  console.log(`Total serials mapped: ${serialMap.size}`);
  console.log(`Final items in result: ${finalItems.length}`);
  console.log('\n=== SAMPLE (first 30) ===');
  finalItems.slice(0, 30).forEach(i => console.log(`${i.name}  | closing=${i.closingQty} | serials=${i.serialCount} | ${i.serials.slice(0, 3).join(', ')}${i.serials.length > 3 ? '...' : ''}`));
  console.log('\nResult saved to extract_stock_result.json');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
