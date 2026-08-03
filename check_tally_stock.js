require('dotenv').config({ path: '.env' });
const t = require('./src/services/tallyService');

const company = 'BLUECHIP COMPUTER SYSTEM - 2024-25';

// Request to list stock groups and items
const xml = `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Stock Query</REPORTNAME>
        <STATICVARIABLES>
          <SVEXPORTFORMAT>\$\$SysName:XML</SVEXPORTFORMAT>
          <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;

async function main() {
  console.log('Fetching stock items from Tally...');
  try {
    const result = await t.rawHttpRequest('http://192.168.2.2:9000', 'POST', {
      'Content-Type': 'text/xml',
      'Content-Length': Buffer.byteLength(xml)
    }, xml, 30000);
    
    console.log('Status:', result.statusCode);
    
    // Find stock item names
    const itemNames = [...new Set(
      (result.body.match(/<NAME[^>]*>([^<]+)<\/NAME>/g) || [])
        .map(m => m.replace(/<[^>]+>/g, ''))
    )];
    console.log('\n--- Stock Items/Names in Tally ---');
    itemNames.forEach((n, i) => console.log(`  ${i+1}. ${n}`));
    
    // Find stock groups
    const groups = [...new Set(
      (result.body.match(/<STOCKGROUP[^>]*>([^<]+)<\/STOCKGROUP>/g) || [])
        .map(m => m.replace(/<[^>]+>/g, ''))
    )];
    console.log('\n--- Stock Groups ---');
    groups.forEach((g, i) => console.log(`  ${i+1}. ${g}`));
    
    // Look for errors
    const lineErr = result.body.match(/<LINEERROR>([^<]+)<\/LINEERROR>/);
    if (lineErr) console.log('\nLINEERROR:', lineErr[1]);
    
    console.log('\nResponse length:', result.body.length);
    console.log('First 1000 chars:', result.body.substring(0, 1000));
    
  } catch (e) {
    console.error('Error:', e.message);
  }
}

main();
