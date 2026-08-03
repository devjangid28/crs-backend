require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');

const COMPANY = 'BLUECHIP COMPUTER SYSTEM - 2024-25';

const VOUCHERS = [
  ['305', '38793ee2-db20-4e07-91e5-ebfa4c80529c-0000446d', '38793ee2-db20-4e07-91e5-ebfa4c80529c-0000b49a:00000010'],
  ['306', '38793ee2-db20-4e07-91e5-ebfa4c80529c-0000446e', '38793ee2-db20-4e07-91e5-ebfa4c80529c-0000b49a:00000018'],
  ['307', '38793ee2-db20-4e07-91e5-ebfa4c80529c-0000446f', '38793ee2-db20-4e07-91e5-ebfa4c80529c-0000b49a:00000020'],
  ['308', '38793ee2-db20-4e07-91e5-ebfa4c80529c-00004470', '38793ee2-db20-4e07-91e5-ebfa4c80529c-0000b49a:00000028'],
];

async function deleteVoucher(num, remote, key) {
  const xml = `<ENVELOPE>
    <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
    <BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Day Book</REPORTNAME>
      <STATICVARIABLES><SVCURRENTCOMPANY>${COMPANY}</SVCURRENTCOMPANY></STATICVARIABLES>
    </REQUESTDESC><REQUESTDATA>
      <TALLYMESSAGE>
        <VOUCHER VCHTYPE="Purchase" ACTION="Delete" REMOTEID="${remote}" VCHKEY="${key}">
        </VOUCHER>
      </TALLYMESSAGE>
    </REQUESTDATA></IMPORTDATA></BODY>
  </ENVELOPE>`;
  const r = await t.rawHttpRequest('http://192.168.2.2:9000', 'POST', {
    'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml),
  }, xml, 30000);
  const del = (r.body.match(/<DELETED>(\d+)<\/DELETED>/) || [])[1];
  const err = (r.body.match(/<LINEERROR>(.*?)<\/LINEERROR>/) || [])[1] || '';
  console.log(`voucher ${num}: deleted=${del} ${err ? '| ' + err.slice(0, 120) : ''}`);
}

async function main() {
  for (const [num, r, k] of VOUCHERS) {
    await deleteVoucher(num, r, k);
  }
}

main().catch((e) => console.error('ERROR:', e.message));
