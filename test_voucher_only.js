require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');

// VK ledger now exists, test voucher only
const cfg = t.getTallyConfig();
const xml = `<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES><SVCURRENTCOMPANY>BLUECHIP COMPUTER SYSTEM - 2024-25</SVCURRENTCOMPANY></STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Sales Asus" ACTION="Create" OBJVIEW="Invoice Voucher View">
            <DATE>20260728</DATE>
            <VOUCHERTYPENAME>Sales Asus</VOUCHERTYPENAME>
            <VOUCHERNUMBER>CRS-TEST-005</VOUCHERNUMBER>
            <PARTYLEDGERNAME>VK</PARTYLEDGERNAME>
            <NARRATION>Test CRS push</NARRATION>
            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>NOTEBOOK ASUS BM1403CDA-S60753X</STOCKITEMNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <RATE>50000/Nos</RATE>
              <AMOUNT>-50000.00</AMOUNT>
              <ACTUALQTY>1 Nos</ACTUALQTY>
              <BILLEDQTY>1 Nos</BILLEDQTY>
              <BATCHALLOCATIONS.LIST>
                <BATCHNAME>Primary</BATCHNAME>
                <SERIALNUMBERLIST><SERIALNUMBER>T5NXCV08Y18620C</SERIALNUMBER></SERIALNUMBERLIST>
                <AMOUNT>-50000.00</AMOUNT>
                <ACTUALQTY>1 Nos</ACTUALQTY>
                <BILLEDQTY>1 Nos</BILLEDQTY>
              </BATCHALLOCATIONS.LIST>
            </ALLINVENTORYENTRIES.LIST>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>VK</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>59000.00</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>SALES @ 18%</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-50000.00</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>OUTPUT CGST @ 9%</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-4500.00</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>OUTPUT SGST @ 9%</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-4500.00</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

t.rawHttpRequest('http://192.168.2.2:9000', 'POST', { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) }, xml)
  .then(r => {
    console.log('FULL RESPONSE:', r.body);
  })
  .catch(e => console.error(e.message));
