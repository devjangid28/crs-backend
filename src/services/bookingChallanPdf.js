// Booking challan PDF generator for Advanced Bookings.
// Reproduces the same A4 "Invoice | Challan" layout used by the frontend
// (src/utils/bookingChallan.js) so the WhatsApp "booking_challan" template can
// attach the challan as a real PDF document.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { query } = require('../config/database');

const PDF_DIR = path.join(__dirname, '../../uploads/pdfs/booking-challans');
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtINR(amount) {
  const val = parseFloat(amount) || 0;
  return '\u20B9' + val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Format a booking date as DD-MM-YYYY without timezone shifts.
// Handles Date objects (pg returns DATE columns as local-midnight Date
// objects), full ISO strings (UTC-shifted), and plain YYYY-MM-DD strings.
function fmtDate(value) {
  if (!value) return '________________';
  try {
    let y, m, d;
    if (value instanceof Date) {
      y = value.getFullYear();
      m = String(value.getMonth() + 1).padStart(2, '0');
      d = String(value.getDate()).padStart(2, '0');
    } else {
      const s = String(value).trim();
      if (s.includes('T')) {
        const dt = new Date(s);
        if (isNaN(dt.getTime())) return String(value);
        y = dt.getFullYear();
        m = String(dt.getMonth() + 1).padStart(2, '0');
        d = String(dt.getDate()).padStart(2, '0');
      } else {
        const parts = s.slice(0, 10).split('-');
        if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return String(value);
        y = parts[0]; m = parts[1]; d = parts[2];
      }
    }
    return `${d}-${m}-${y}`;
  } catch {
    return String(value);
  }
}

// Load the Bluechip logo as a base64 data URL so puppeteer can render it
// offline. Falls back to the store logo when available.
function loadLogoBase64(store) {
  const candidates = [];
  if (store && store.logo) {
    const logoPath = String(store.logo).replace(/^\/+/, '');
    candidates.push(path.join(__dirname, '../..', logoPath));
  }
  candidates.push(path.join(__dirname, '../../..', 'public', 'BLUECHIP LOGO-01.png'));
  candidates.push(path.join(__dirname, '../../..', 'public', 'BLUECHIP%20LOGO-01.png'));
  candidates.push(path.join(__dirname, '../../..', 'public', 'BLUECHIP%20LOGO-01.jpg'));
  for (const abs of candidates) {
    try {
      if (fs.existsSync(abs)) {
        const ext = path.extname(abs).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.svg' ? 'image/svg+xml' : 'image/jpeg';
        return 'data:' + mime + ';base64,' + fs.readFileSync(abs).toString('base64');
      }
    } catch (e) {
      // try next candidate
    }
  }
  return '';
}

// Load the "stamp & sign" image as a base64 data URL for the signature block.
function loadStampBase64() {
  const candidates = [
    path.join(__dirname, '../../public', 'stamp-sign.jpg'),
    path.join(__dirname, '../../public', 'stamp-sign.JPG'),
    path.join(__dirname, '../../public', 'stamp and sign.JPG'),
    path.join(__dirname, '../../public', 'stamp and sign.jpg'),
    path.join(__dirname, '../../..', 'public', 'stamp-sign.jpg'),
    path.join(__dirname, '../../..', 'public', 'stamp and sign.JPG'),
  ];
  for (const abs of candidates) {
    try {
      if (fs.existsSync(abs)) {
        const ext = path.extname(abs).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.svg' ? 'image/svg+xml' : 'image/jpeg';
        return 'data:' + mime + ';base64,' + fs.readFileSync(abs).toString('base64');
      }
    } catch (e) {
      // try next candidate
    }
  }
  return '';
}

function buildItems(booking, products) {
  const source = Array.isArray(products) && products.length > 0
    ? products
    : [];
  if (source.length > 0) {
    return source.map(p => ({
      name: p.product_name || 'Device',
      accessoryType: p.accessory_type || '',
      model: p.product_model || '',
      serial: p.serial_number || '',
      warranty: p.warranty || '',
      partNo: p.part_no || '',
      checkNo: p.check_no || '',
      specifications: p.specifications || null,
      qty: parseInt(p.quantity, 10) || 1,
      amount: parseFloat(p.amount) || 0,
    }));
  }
  return [{
    name: booking.device_type || 'Device',
    accessoryType: booking.accessory_type || '',
    model: booking.model || '',
    serial: booking.serial_number || '',
    warranty: booking.warranty || '',
    partNo: booking.part_no || '',
    checkNo: booking.check_no || '',
    specifications: null,
    qty: 1,
    amount: parseFloat(booking.total_amount || booking.grand_total) || 0,
  }];
}

function particularRows(item) {
  const lines = [];
  let title = item.name;
  if (String(item.name).toLowerCase() === 'accessories' && item.accessoryType) {
    title = item.accessoryType;
  } else if (String(item.name).toLowerCase() !== 'accessories' && item.accessoryType) {
    title = item.accessoryType;
  }
  lines.push('<div class="p-title">' + esc(title) + '</div>');
  if (item.model) lines.push('<div class="p-line">Model : ' + esc(item.model) + '</div>');
  if (item.serial) lines.push('<div class="p-line">Sr.No : ' + esc(item.serial) + '</div>');
  if (item.warranty && String(item.warranty).toLowerCase().trim() !== 'no warranty') {
    lines.push('<div class="p-line">Warranty : ' + esc(item.warranty) + '</div>');
  }
  if (item.partNo) lines.push('<div class="p-line">Part No : ' + esc(item.partNo) + '</div>');
  if (item.checkNo) lines.push('<div class="p-line">Check No : ' + esc(item.checkNo) + '</div>');
  const specRows = particularSpecRows(item.specifications);
  if (specRows) lines.push(specRows);
  return lines;
}

function particularSpecRows(specs) {
  if (!specs || typeof specs !== 'object') return '';
  const order = [
    [['processor', 'Processor'], 'Processor'],
    [['memory', 'ram', 'RAM', 'Memory'], 'Memory'],
    [['storage', 'ssd', 'SSD', 'Storage'], 'Storage'],
    [['screenSize', 'screen_size', 'ScreenSize', 'displaySize', 'Screen Size'], 'Screen Size'],
    [['graphics', 'graphicsCard', 'graphics_card', 'GraphicsCard', 'Graphics'], 'Graphics'],
    [['software', 'windows', 'Windows', 'Software'], 'Software'],
    [['colour', 'color', 'Color', 'Colour'], 'Colour'],
  ];
  const used = new Set();
  let html = '';
  for (const [keys, label] of order) {
    let v = '';
    for (const k of keys) {
      if (specs[k] !== undefined && specs[k] !== null) {
        v = String(specs[k]).trim();
        if (v) break;
      }
    }
    keys.forEach(k => used.add(k));
    if (!v) continue;
    html += '<div class="p-line"><b>' + esc(label) + ' :</b> ' + esc(v) + '</div>';
  }
  Object.keys(specs).forEach((key) => {
    if (used.has(key)) return;
    const val = specs[key];
    if (val === undefined || val === null) return;
    const v = String(val).trim();
    if (!v) return;
    html += '<div class="p-line"><b>' + esc(key) + ' :</b> ' + esc(v) + '</div>';
  });
  return html;
}

function buildBookingChallanHtml(booking, products, store) {
  const logo = loadLogoBase64(store);
  const stamp = loadStampBase64();
  const items = buildItems(booking, products);
  const totalAmount = items.reduce((sum, it) => sum + it.amount, 0);
  const advance = parseFloat(booking.advance_payment) || 0;
  const balance = Math.max(totalAmount - advance, 0);
  const payMode = booking.advance_payment_mode || '';
  const bookingNo = booking.order_number || booking.booking_number || '';
  const date = fmtDate(booking.order_date || booking.booking_date);
  const customerName = booking.customer_name || '';
  const customerMobile = booking.mobile_number || '';

  const itemHtml = items.map((it, idx) => {
    const rate = it.qty > 0 ? it.amount / it.qty : it.amount;
    return '<tr>'
      + '<td class="td-c">' + (idx + 1) + '</td>'
      + '<td class="td-l">' + particularRows(it).join('') + '</td>'
      + '<td class="td-c">' + it.qty + '</td>'
      + '<td class="td-r">' + fmtINR(rate) + '</td>'
      + '<td class="td-r">' + fmtINR(it.amount) + '</td>'
      + '</tr>';
  }).join('');

  const spacerHeight = Math.max(30, Math.round(85 - items.length * 10));
  const spacer = '<tr>'
    + '<td style="height:' + spacerHeight + 'mm"></td>'
    + '<td></td><td></td><td></td><td></td>'
    + '</tr>';

  const terms = [
    'Booking Amount is Not Refundable',
    'Given price is only valid till offer period',
    'Late payment interest rate @24%',
    'Goods once sold will not be taken back/return.',
    'Warranty as per principle norms.',
    'Subjects to vadodara jurisdiction.',
  ].map(function(t) { return '<div class="t-item">&#8226; ' + esc(t) + '</div>'; }).join('');

  var logoHtml = logo
    ? '<img src="' + logo + '" alt="Logo" />'
    : '<div style="font-size:12px;font-weight:700;color:#0b3d91;">BLUECHIP COMPUTER SYSTEMS</div>';

  var stampHtml = stamp
    ? '<img class="stamp" src="' + stamp + '" alt="Stamp & Sign" />'
    : '';

  var css = '\
    @page { size: A4 portrait; margin: 0; }\n\
    * { box-sizing: border-box; margin: 0; padding: 0; }\n\
    html, body { margin: 0; padding: 0; background: #fff; }\n\
    body { font-family: Arial, Helvetica, sans-serif; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }\n\
    .page { width: 210mm; height: 297mm; padding: 15mm 13.5mm 25mm 13.5mm; background: #fff; }\n\
    .invoice { width: 183mm; height: 238mm; border: 0.55mm solid #1a1a1a; border-radius: 6px; display: flex; flex-direction: column; overflow: hidden; }\n\
    .tstrip { display: flex; justify-content: center; padding-top: 6mm; }\n\
    .tstrip .box { width: 48mm; height: 6.5mm; background: #000; color: #fff; font-size: 9.5px; font-weight: 700; letter-spacing: 1px; display: flex; align-items: center; justify-content: center; }\n\
    .head { display: flex; border-top: 0.4mm solid #000; margin-top: 4.5mm; border-bottom: 0.5mm solid #000; }\n\
    .head-left { width: 57%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2mm 3mm 2.5mm; }\n\
    .head-left img { height: 22mm; max-width: 70mm; object-fit: contain; }\n\
    .head-right { width: 43%; border-left: 0.5mm solid #000; padding: 2.2mm 3mm 2.2mm 4mm; font-size: 7.8px; line-height: 1.6; }\n\
    .head-right .b { font-weight: 700; }\n\
    .head-right .e { color: #000; }\n\
    .meta { display: flex; border-bottom: 0.5mm solid #000; }\n\
    .meta-left { width: 70%; padding: 2.5mm 3mm; font-size: 8.6px; }\n\
    .to-line { display: flex; align-items: baseline; }\n\
    .to-line b { font-weight: 700; margin-right: 2mm; width: 6mm; flex-shrink: 0; }\n\
    .to-line .nm { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n\
    .to-mob { margin-top: 1.2mm; display: flex; align-items: baseline; }\n\
    .to-mob b { font-weight: 700; margin-right: 2mm; }\n\
    .meta-right { width: 30%; border-left: 0.5mm solid #000; }\n\
    .meta-right .rrow { padding: 1.8mm 2.5mm; font-size: 8.6px; }\n\
    .meta-right .rrow + .rrow { border-top: 0.45mm solid #000; }\n\
    .no-val { color: #e00000; font-weight: 700; margin-left: 1mm; }\n\
    table.main { width: 100%; border-collapse: collapse; table-layout: fixed; }\n\
    table.main colgroup col:nth-child(1) { width: 9%; }\n\
    table.main colgroup col:nth-child(2) { width: 41%; }\n\
    table.main colgroup col:nth-child(3) { width: 10%; }\n\
    table.main colgroup col:nth-child(4) { width: 11%; }\n\
    table.main colgroup col:nth-child(5) { width: 29%; }\n\
    table.main th { font-weight: 700; text-align: center; background: #fff; }\n\
    table.main th, table.main td { border: 0.4mm solid #000; padding: 1.5mm 2mm; font-size: 8.6px; vertical-align: top; }\n\
    .td-c { text-align: center; }\n\
    .td-r { text-align: right; }\n\
    .td-l { text-align: left; }\n\
    .p-title { font-weight: 700; }\n\
    .p-line { font-size: 7.4px; line-height: 1.45; }\n\
    .total-row td { font-weight: 700; }\n\
    .pay { padding: 2mm 3mm 0; font-size: 8.6px; font-weight: 700; }\n\
    .terms { padding: 2mm 3mm 0; font-size: 8.6px; line-height: 1.55; }\n\
    .terms h4 { font-size: 8.6px; font-weight: 700; margin-bottom: 0.8mm; }\n\
    .t-item { padding-left: 1mm; }\n\
    .blank-flex { flex: 1; }\n\
    .sign { display: flex; justify-content: space-between; align-items: flex-end; padding: 6mm 5mm 4mm; font-size: 8.6px; }\n\
    .sign .right { text-align: right; position: relative; }\n\
    .sign .stamp { position: absolute; right: 0; bottom: calc(100% + 5px); height: 18mm; max-width: 48mm; object-fit: contain; }\n';

  return '<!DOCTYPE html>\n\
<html lang="en">\n\
<head>\n\
<meta charset="utf-8" />\n\
<title>' + esc(bookingNo) + '</title>\n\
<style>\n' + css + '\n</style>\n\
</head>\n\
<body>\n\
<div class="page">\n\
<div class="invoice">\n\
\n\
<div class="tstrip"><div class="box">Invoice | Challan</div></div>\n\
\n\
<div class="head">\n\
  <div class="head-left">\n\
    ' + logoHtml + '\n\
  </div>\n\
  <div class="head-right">\n\
    <div class="b">BCSs: 001, Varundavan Complex, 29B</div>\n\
    <div>Nutan Bharat Society, Opp. M.K. High</div>\n\
    <div>School, Alkapuri, Baroda - 390 007</div>\n\
    <div class="e">&nbsp;</div>\n\
    <div class="e">(E): bluechipcs@yahoo.com</div>\n\
    <div class="e">(M): +91 90168 06113&nbsp;&nbsp;+91 90991 28072</div>\n\
    <div class="e">(GST IN): 24AANFB3011M1Z6</div>\n\
  </div>\n\
</div>\n\
\n\
<div class="meta">\n\
  <div class="meta-left">\n\
    <div class="to-line">\n\
      <b>To:</b>\n\
      <span class="nm">' + esc(customerName) + '</span>\n\
    </div>\n\
    <div class="to-mob">\n\
      <b>Mobile no :</b>\n\
      <span>' + esc(customerMobile || '________________') + '</span>\n\
    </div>\n\
  </div>\n\
  <div class="meta-right">\n\
    <div class="rrow">No: <span class="no-val">' + esc(bookingNo) + '</span></div>\n\
    <div class="rrow">Date: ' + esc(date) + '</div>\n\
  </div>\n\
</div>\n\
\n\
<table class="main">\n\
<colgroup>\n\
  <col /><col /><col /><col /><col />\n\
</colgroup>\n\
<thead>\n\
<tr>\n\
  <th>Sr.</th>\n\
  <th>Particulars</th>\n\
  <th>Qty</th>\n\
  <th>Rate</th>\n\
  <th>Amount</th>\n\
</tr>\n\
</thead>\n\
<tbody>\n\
' + itemHtml + '\n\
' + spacer + '\n\
<tr class="total-row">\n\
  <td class="td-l">TOTAL</td>\n\
  <td></td>\n\
  <td></td>\n\
  <td></td>\n\
  <td class="td-r">' + fmtINR(totalAmount) + '</td>\n\
</tr>\n\
</tbody>\n\
</table>\n\
\n\
<div class="pay">Advance Received : ' + fmtINR(advance) + '&nbsp;&nbsp;&nbsp;Mode : ' + esc(payMode || '\u2014') + '&nbsp;&nbsp;&nbsp;Balance Payable : ' + fmtINR(balance) + '</div>\n\
\n\
<div class="terms">\n\
  <h4>Terms &amp; Condition</h4>\n\
  ' + terms + '\n\
</div>\n\
\n\
<div class="blank-flex"></div>\n\
\n\
<div class="sign">\n\
  <div>Receiver\'s Signature</div>\n\
  <div class="right">' + stampHtml + '<div>For, Bluechip Computer Systems</div></div>\n\
</div>\n\
\n\
</div>\n\
</div>\n\
</body>\n\
</html>';
}

async function getStoreData(storeId) {
  let store;
  if (storeId) {
    const sRes = await query('SELECT * FROM stores WHERE id = $1 AND is_active = true', [storeId]);
    if (sRes.rows.length > 0) store = sRes.rows[0];
  }
  if (!store) {
    const defRes = await query('SELECT * FROM stores WHERE is_default = true AND is_active = true LIMIT 1');
    if (defRes.rows.length > 0) store = defRes.rows[0];
  }
  if (!store) {
    const cRes = await query('SELECT * FROM store_settings LIMIT 1');
    store = cRes.rows[0] || {};
  }
  return store || {};
}

// Generate the booking challan PDF for an advanced-booking order.
async function generateBookingChallanPdf(orderId) {
  const oRes = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (oRes.rows.length === 0) throw new Error('Order not found');
  const order = oRes.rows[0];

  const prodRes = await query(
    `SELECT product_name, product_model, serial_number, warranty, quantity, rate, amount,
            accessory_type, part_no, check_no, series, specifications
     FROM order_products WHERE order_id = $1 ORDER BY id`,
    [orderId]
  );
  const products = prodRes.rows || [];

  const store = await getStoreData(order.store_id);

  const orderNumber = order.order_number || orderId;
  const fileName = `Booking_Challan_${orderNumber}.pdf`;
  const filePath = path.join(PDF_DIR, fileName);

  const html = buildBookingChallanHtml(order, products, store);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: filePath,
      format: 'A4',
      printBackground: true,
      margin: { top: '8mm', bottom: '8mm', left: '8mm', right: '8mm' },
    });
  } finally {
    await browser.close();
  }

  const stats = fs.statSync(filePath);
  return { filePath, fileName, fileSize: stats.size, orderNumber };
}

module.exports = { generateBookingChallanPdf };