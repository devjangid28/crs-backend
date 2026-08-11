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
     'ALLINVENTORYENTRIES.LIST', 'SERIALNUMBERLIST', 'SERIALNUMBER'].includes(name),
});

const company = process.env.TALLY_COMPANY || 'BLUECHIP COMPUTER SYSTEM - 2024-25';
const url = `http://${process.env.TALLY_HOST || '192.168.2.19'}:${process.env.TALLY_PORT || 9000}`;

async function post(xml, timeout = 120000) {
  const r = await t.rawHttpRequest(url, 'POST', {
    'Content-Type': 'text/xml',
    'Content-Length': Buffer.byteLength(xml),
  }, xml, timeout);
  return r.body;
}

function buildDayBookXml() {
  return `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Day Book</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY><SVFROMDATE>01-Apr-2024</SVFROMDATE><SVTODATE>$$SysName:Today</SVTODATE></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`;
}

async function main() {
  console.log(`Fetching full Day Book from ${url} ...`);
  const body = await post(buildDayBookXml());
  fs.writeFileSync('./extract_daybook.xml', body);
  console.log('Day Book saved, size:', body.length);

  const parsed = parser.parse(body);
  const msgs = parsed?.ENVELOPE?.BODY?.IMPORTDATA?.REQUESTDATA?.TALLYMESSAGE
    || parsed?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE || [];
  const msgArr = Array.isArray(msgs) ? msgs : [msgs];

  let vchCount = 0;
  const voucherTypes = new Set();
  const serials = [];        // all serial numbers found
  const stockMovements = new Map(); // stockName -> { purchased: 0, sold: 0 }
  const serialByStock = new Map();  // stockName -> [serials]

  for (const msg of msgArr) {
    const vouchers = msg?.VOUCHER || [];
    const vArr = Array.isArray(vouchers) ? vouchers : [vouchers];
    for (const v of vArr) {
      vchCount++;
      const vchType = v?.['@_VCHTYPE'] || v?.VOUCHERTYPENAME || '';
      voucherTypes.add(vchType);
      const party = v?.PARTYLEDGERNAME || v?.PARTYNAME || '';
      const date = v?.DATE || '';
      const num = v?.VOUCHERNUMBER || '';
      const isSale = /sale/i.test(vchType);

      const invAll = v?.['ALLINVENTORYENTRIES.LIST'] || [];
      const invArr = Array.isArray(invAll) ? invAll : [invAll];
      for (const inv of invArr) {
        const stockName = inv?.STOCKITEMNAME || '';
        const rate = (inv?.RATE || '').replace('/Qty', '').replace('/Nos', '').trim();
        const batches = inv?.['BATCHALLOCATIONS.LIST'] || inv?.BATCHALLOCATIONS?.LIST || [];
        const bArr = Array.isArray(batches) ? batches : [batches];
        for (const b of bArr) {
          const serialNos = b?.SERIALNUMBERLIST?.SERIALNUMBER || [];
          const sArr = Array.isArray(serialNos) ? serialNos : [serialNos];
          for (const s of sArr) {
            const sn = (typeof s === 'string' ? s : s?.['#text'] || '').trim();
            if (sn) {
              serials.push({ serial: sn, stockName, vchType, party, date, num, rate });
              if (!serialByStock.has(stockName)) serialByStock.set(stockName, []);
              serialByStock.get(stockName).push(sn);
            }
          }
          // batch name as serial (when not "Primary")
          const bn = (b?.BATCHNAME || '').trim();
          if (bn && bn !== 'Primary' && !/^Primary\s*Batch$/i.test(bn)) {
            serials.push({ serial: bn, stockName, vchType, party, date, num, rate });
            if (!serialByStock.has(stockName)) serialByStock.set(stockName, []);
            serialByStock.get(stockName).push(bn);
          }
        }
        if (stockName) {
          if (!stockMovements.has(stockName)) stockMovements.set(stockName, { purchased: 0, sold: 0, rate: rate || '' });
          const m = stockMovements.get(stockName);
          if (isSale) m.sold += 1; else m.purchased += 1;
          if (rate && !m.rate) m.rate = rate;
        }
      }
    }
  }

  const uniqueSerials = new Set(serials.map(s => s.serial));
  const uniqueSerialList = [...uniqueSerials];

  const result = {
    company,
    fetchedAt: new Date().toISOString(),
    voucherCount: vchCount,
    voucherTypes: [...voucherTypes],
    uniqueSerials: uniqueSerialList.length,
    serials,
    stockMovements: [...stockMovements.entries()].map(([k, v]) => ({ name: k, ...v })),
  };
  fs.writeFileSync('./extract_daybook_result.json', JSON.stringify(result, null, 2));
  console.log('\n=== DAYBOOK SUMMARY ===');
  console.log('Vouchers:', vchCount);
  console.log('Voucher types:', [...voucherTypes].join(', '));
  console.log('Unique serials:', uniqueSerialList.length);
  console.log('\nStock items seen in vouchers:');
  [...stockMovements.entries()].forEach(([k, v]) => console.log(`  ${k} | in=${v.purchased} out=${v.sold} rate=${v.rate}`));
  console.log('\nSample serials (first 25):');
  uniqueSerialList.slice(0, 25).forEach(s => {
    const rec = serials.find(x => x.serial === s);
    console.log(`  ${s}  <- ${rec.stockName} (${rec.vchType}, ${rec.date})`);
  });
  console.log('\nSaved extract_daybook_result.json');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
