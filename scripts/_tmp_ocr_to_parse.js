// Throwaway: runs the real OCR output above through the parser, so the checks
// use text as PaddleOCR actually returns it (labels split from values, HSN on
// its own line) rather than tidied-up invoice text.
const { parseInvoiceText, isValidGstin } = require('../src/services/invoiceOcrParser');

const ocrText = `SHRI SAI ENTERPRISES
12, GIDC INDUSTRIAL AREA, VADODARA, GUJARAT 390010
GSTIN: 27AAPFU0939F1ZV PHONE: 9876543210
TAX INVOICE
Invoice No: SI/2026/0148
3Invoice Date: 05/10/2026
S.No Description
HSN Code Qty Rate Amount
1 Samsung 8GB DDR4 3200MHz RAM
8542
10 1250.00 12500.00
2 Kingston SSD 240GB SATA
8471
5 2100.00 10500.00
Sub Total:
23000.00
GST @ 18%:
4140.00
Grand Total:
27140.00`;

const r = parseInvoiceText(ocrText);
const s = r.suggestion;
console.log('party      :', s.partyName || '(none)');
console.log('gstin      :', s.partyGstin || '(none)', s.partyGstin ? `(checksum ${isValidGstin(s.partyGstin) ? 'OK' : 'BAD'})` : '');
console.log('invoice no :', s.invoiceNo || '(none)');
console.log('date       :', s.invoiceDate || '(none)');
console.log('phone      :', s.partyPhone || '(none)');
console.log('items      :', s.items.length);
s.items.forEach(i => console.log(`   - ${i.itemName} | qty ${i.quantity} | rate ${i.rate} | amt ${i.amount} | hsn ${i.hsnCode || '-'}`));
console.log('totals     :', JSON.stringify(s.printedTotals));
if (r.totalCheck) console.log('total check:', r.totalCheck.matches ? 'MATCH' : 'MISMATCH', r.totalCheck.comparedAgainst, r.totalCheck.difference);
r.warnings.forEach(w => console.log('WARNING    :', w));
console.log(s.items.length === 2 ? 'ITEM COUNT OK' : `ITEM COUNT WRONG (${s.items.length})`);