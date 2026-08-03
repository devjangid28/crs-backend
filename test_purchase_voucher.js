require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');

const COMPANY = 'BLUECHIP COMPUTER SYSTEM - 2024-25';

function buildPurchaseVoucherTest() {
  const itemName = 'TEST PURCHASE FLOW LAPTOP';
  const supplier = 'TEST PURCHASE SUPPLIER';
  const qty = 1;
  const rate = 50000.00;
  const amount = (qty * rate).toFixed(2); // 50000.00
  const gstRate = 18;
  const cgst = (amount * (gstRate / 2) / 100).toFixed(2); // 4500
  const sgst = cgst;
  const grandTotal = (parseFloat(amount) + parseFloat(cgst) + parseFloat(sgst)).toFixed(2); // 59000
  const date = '20260801';
  const serials = ['TPFLOW-SER-0001'];

  return `<ENVELOPE>
    <HEADER>
      <TALLYREQUEST>Import Data</TALLYREQUEST>
    </HEADER>
    <BODY>
      <IMPORTDATA>
        <REQUESTDESC>
          <REPORTNAME>Vouchers</REPORTNAME>
          <STATICVARIABLES><SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY></STATICVARIABLES>
        </REQUESTDESC>
        <REQUESTDATA>
          <TALLYMESSAGE xmlns:UDF="TallyUDF">
            <STOCKITEM NAME="${itemName}" ACTION="Create">
              <NAME>${itemName}</NAME>
              <PARENT>Notebook</PARENT>
              <BASEUNITS>Qty</BASEUNITS>
              <GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE>
              <GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>
              <GSTDETAILS.LIST>
                <APPLICABLEFROM>20240401</APPLICABLEFROM>
                <HSNCODE>84713000</HSNCODE>
                <HSN>Laptop Computer</HSN>
                <SRCOFGSTDETAILS>Specify Details Here</SRCOFGSTDETAILS>
                <TAXABILITY>Taxable</TAXABILITY>
                <STATEWISEDETAILS.LIST>
                  <STATENAME>&#4; Any</STATENAME>
                  <RATEDETAILS.LIST>
                    <GSTRATEDUTYHEAD>CGST</GSTRATEDUTYHEAD>
                    <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
                    <GSTRATE> 9</GSTRATE>
                  </RATEDETAILS.LIST>
                  <RATEDETAILS.LIST>
                    <GSTRATEDUTYHEAD>SGST/UTGST</GSTRATEDUTYHEAD>
                    <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>
                    <GSTRATE> 9</GSTRATE>
                  </RATEDETAILS.LIST>
                </STATEWISEDETAILS.LIST>
              </GSTDETAILS.LIST>
            </STOCKITEM>
          </TALLYMESSAGE>
          <TALLYMESSAGE xmlns:UDF="TallyUDF">
            <LEDGER NAME="${supplier}" ACTION="Create">
              <NAME>${supplier}</NAME>
              <PARENT>Sundry Creditors</PARENT>
            </LEDGER>
          </TALLYMESSAGE>
          <TALLYMESSAGE xmlns:UDF="TallyUDF">
            <VOUCHER VCHTYPE="Purchase" ACTION="Create" OBJVIEW="Invoice Voucher View">
              <DATE>${date}</DATE>
              <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
              <PARTYLEDGERNAME>${supplier}</PARTYLEDGERNAME>
              <REFERENCE>INV/TEST/001</REFERENCE>
              <NARRATION>CRS purchase flow test</NARRATION>
              <ALLINVENTORYENTRIES.LIST>
                <STOCKITEMNAME>${itemName}</STOCKITEMNAME>
                <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
                <RATE>${rate.toFixed(2)}/Qty</RATE>
                <AMOUNT>-${amount}</AMOUNT>
                <ACTUALQTY> ${qty} Qty</ACTUALQTY>
                <BILLEDQTY> ${qty} Qty</BILLEDQTY>
                <BATCHALLOCATIONS.LIST>
                  <GODOWNNAME>Main Location</GODOWNNAME>
                  <BATCHNAME>Primary Batch</BATCHNAME>
                  <AMOUNT>-${amount}</AMOUNT>
                  <ACTUALQTY> ${qty} Qty</ACTUALQTY>
                  <BILLEDQTY> ${qty} Qty</BILLEDQTY>
                  <SERIALNUMBERLIST>
                    ${serials.map(s => `<SERIALNUMBER>${s}</SERIALNUMBER>`).join('\n                    ')}
                  </SERIALNUMBERLIST>
                </BATCHALLOCATIONS.LIST>
                <ACCOUNTINGALLOCATIONS.LIST>
                  <LEDGERNAME>PURCHASE @ 18%</LEDGERNAME>
                  <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
                  <AMOUNT>-${amount}</AMOUNT>
                </ACCOUNTINGALLOCATIONS.LIST>
                <GSTSOURCETYPE>Ledger</GSTSOURCETYPE>
                <GSTLEDGERSOURCE>PURCHASE @ 18%</GSTLEDGERSOURCE>
                <HSNSOURCETYPE>Stock Item</HSNSOURCETYPE>
                <GSTHSNNAME>84713000</GSTHSNNAME>
                <GSTHSNDESCRIPTION>Laptop Computer</GSTHSNDESCRIPTION>
                <GSTOVRDNTYPEOFSUPPLY>Goods</GSTOVRDNTYPEOFSUPPLY>
              </ALLINVENTORYENTRIES.LIST>
              <LEDGERENTRIES.LIST>
                <LEDGERNAME>${supplier}</LEDGERNAME>
                <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
                <AMOUNT>${grandTotal}</AMOUNT>
              </LEDGERENTRIES.LIST>
              <LEDGERENTRIES.LIST>
                <LEDGERNAME>INPUT CGST @ 9%</LEDGERNAME>
                <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
                <AMOUNT>-${cgst}</AMOUNT>
                <RATEOFINVOICETAX.LIST TYPE="Number">
                  <RATEOFINVOICETAX> 9</RATEOFINVOICETAX>
                </RATEOFINVOICETAX.LIST>
              </LEDGERENTRIES.LIST>
              <LEDGERENTRIES.LIST>
                <LEDGERNAME>INPUT SGST @ 9%</LEDGERNAME>
                <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
                <AMOUNT>-${sgst}</AMOUNT>
                <RATEOFINVOICETAX.LIST TYPE="Number">
                  <RATEOFINVOICETAX> 9</RATEOFINVOICETAX>
                </RATEOFINVOICETAX.LIST>
              </LEDGERENTRIES.LIST>
            </VOUCHER>
          </TALLYMESSAGE>
        </REQUESTDATA>
      </IMPORTDATA>
    </BODY>
  </ENVELOPE>`;
}

async function main() {
  const xml = buildPurchaseVoucherTest();
  const r = await t.rawHttpRequest('http://192.168.2.2:9000', 'POST', {
    'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml),
  }, xml, 40000);
  console.log('=== RESPONSE ===');
  console.log(r.body);
}

main().catch((e) => console.error('ERROR:', e.message, e.stack));
