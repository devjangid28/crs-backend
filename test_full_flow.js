require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');

// Step 1: Create a Purchase Asus voucher to add the stock item into Tally
// This simulates the item being purchased/received into Tally stock
async function createPurchaseVoucher(stockName, serial, rate, partyName, date) {
  const cfg = t.getTallyConfig();
  const escapeXml = (s) => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

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
          <LEDGER NAME="${escapeXml(partyName)}" ACTION="Create">
            <NAME>${escapeXml(partyName)}</NAME>
            <PARENT>Sundry Creditors</PARENT>
          </LEDGER>
        </TALLYMESSAGE>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <STOCKITEM NAME="${escapeXml(stockName)}" ACTION="Create">
            <NAME>${escapeXml(stockName)}</NAME>
            <PARENT>Laptop</PARENT>
            <BASEUNITS>Nos</BASEUNITS>
            <ISBATCHWISEON>Yes</ISBATCHWISEON>
            <ISSERIALNUMBERON>Yes</ISSERIALNUMBERON>
          </STOCKITEM>
        </TALLYMESSAGE>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Purchase Asus" ACTION="Create" OBJVIEW="Invoice Voucher View">
            <DATE>${date}</DATE>
            <VOUCHERTYPENAME>Purchase Asus</VOUCHERTYPENAME>
            <VOUCHERNUMBER>CRS-PUR-${serial.substring(0,8)}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>${escapeXml(partyName)}</PARTYLEDGERNAME>
            <NARRATION>Stock entry via CRS for serial ${escapeXml(serial)}</NARRATION>
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
              <LEDGERNAME>${escapeXml(partyName)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-${rate}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Purchase Asus</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>${rate}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

  const r = await t.rawHttpRequest('http://192.168.2.2:9000', 'POST', {
    'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml)
  }, xml);
  return r.body;
}

async function main() {
  console.log('=== Step 1: Creating stock item + purchase voucher in Tally ===');
  const purchaseResp = await createPurchaseVoucher(
    'NOTEBOOK ASUS BM1403CDA-S60753X',
    'T5NXCV08Y18620C',
    50000,
    'ASUS India',
    '20260701'
  );
  console.log('Purchase response:', purchaseResp);

  const created = (purchaseResp.match(/<CREATED>(\d+)<\/CREATED>/) || [])[1];
  const exceptions = (purchaseResp.match(/<EXCEPTIONS>(\d+)<\/EXCEPTIONS>/) || [])[1];
  console.log(`Created: ${created}, Exceptions: ${exceptions}`);

  if (parseInt(created) > 0 || purchaseResp.includes('<CREATED>')) {
    console.log('\n=== Step 2: Now testing Sales push ===');
    const result = await t.pushSalesVoucherWithRetry({
      partyName: 'VK',
      voucherNumber: 'CRS-SALE-TEST-001',
      items: [{
        name: 'NOTEBOOK ASUS BM1403CDA-S60753X',
        serialNumber: 'T5NXCV08Y18620C',
        qty: 1,
        price: 50000,
        discount: 0,
        batch: 'Primary',
        skipInventory: false
      }],
      taxRate: 18,
      narration: 'Test sale via CRS',
      date: '20260728'
    }, 1);
    console.log('Sales push result:', JSON.stringify(result));
  }
}

main().catch(console.error);
