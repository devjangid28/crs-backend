const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { query } = require('../config/database');
const { generateInwardReceiptHtml } = require('./inwardPdfHtml');
const { populateInwardTemplate } = require('./inwardTemplateService');

const PDF_DIR = path.join(__dirname, '../../uploads/pdfs');
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatCurrency(amount) {
  return '₹' + (parseFloat(amount) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

async function generateInwardReceipt(ticketId) {
  const tRes = await query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
  if (tRes.rows.length === 0) throw new Error('Ticket not found');
  const t = tRes.rows[0];

  const cRes = await query('SELECT * FROM store_settings LIMIT 1');
  const store = cRes.rows[0] || {};

  const dir = path.join(PDF_DIR, 'inward');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const fileName = `Inward_Receipt_${t.ticket_id}.pdf`;
  const filePath = path.join(dir, fileName);

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const ml = 40;
  const pw = doc.page.width - ml * 2;
  let y = 40;

  function sectionTitle(text) {
    doc.rect(ml, y, pw, 16).fill('#F5F7FA');
    doc.fillAndStroke('#1565C0', '#D9D9D9');
    doc.rect(ml, y, pw, 16).stroke('#D9D9D9');
    doc.fillColor('#1565C0').fontSize(8).font('Helvetica-Bold').text(text.toUpperCase(), ml + 8, y + 4);
    y += 16;
  }

  function sectionBody() {
    return y;
  }

  function endSection(bodyTop, bodyPad, h) {
    const extraH = h || (y - bodyTop);
    doc.rect(ml, bodyTop, pw, extraH).stroke('#D9D9D9');
  }

  function fld(label, value, x, w) {
    x = x || ml + 8;
    w = w || 0;
    const fw = w || (pw - 16) / 2;
    doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#888');
    doc.text(label.toUpperCase(), x, y, { width: fw });
    doc.fontSize(8).font('Helvetica').fillColor('#333');
    const lh = doc.heightOfString(value || '', { width: fw });
    doc.text(value || '', x, y + 9, { width: fw });
    const used = Math.max(18, 9 + lh);
    y += used + 2;
    return used + 2;
  }

  function drawFieldRow(cols) {
    const n = cols.length;
    const cw = (pw - 16) / n;
    let maxH = 0;
    const positions = cols.map((c, i) => {
      const x = ml + 8 + i * cw;
      doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#888');
      doc.text(c.label.toUpperCase(), x, y, { width: cw - 4 });
      doc.fontSize(8).font('Helvetica').fillColor('#333');
      const val = c.value || '';
      doc.text(val, x, y + 9, { width: cw - 4 });
      const vh = doc.heightOfString(val, { width: cw - 4 }) + 9;
      maxH = Math.max(maxH, vh);
      return { x, w: cw };
    });
    y += maxH + 4;
  }

  // ── HEADER ──
  const hdrH = 60;
  doc.rect(ml, y, pw, hdrH).stroke('#D9D9D9');
  doc.moveTo(ml + pw * 0.35, y).lineTo(ml + pw * 0.35, y + hdrH).stroke('#D9D9D9');
  if (store.logo && fs.existsSync(path.join(__dirname, '../../', store.logo))) {
    try { doc.image(path.join(__dirname, '../../', store.logo), ml + 8, y + 4, { width: 50 }); } catch (e) { /* skip */ }
  }
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#1565C0');
  doc.text(store.company_name || 'REPAIR SHOP', ml + 8, y + hdrH - 18, { width: pw * 0.35 - 16 });
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1565C0');
  doc.text('REPAIR ORDER', ml + pw * 0.35 + 8, y + 6, { width: pw * 0.65 - 16, align: 'right' });
  doc.fontSize(6.5).font('Helvetica').fillColor('#666');
  const addrParts = [store.address, [store.city, store.state].filter(Boolean).join(', ')].filter(Boolean);
  doc.text(addrParts.join(', ') + (store.pincode ? ' - ' + store.pincode : ''), ml + pw * 0.35 + 8, y + 22, { width: pw * 0.65 - 16, align: 'right' });
  doc.text('Phone: ' + (store.phone || ''), ml + pw * 0.35 + 8, y + 33, { width: pw * 0.65 - 16, align: 'right' });
  doc.text('GST: ' + (store.gst_vat || 'N/A'), ml + pw * 0.35 + 8, y + 44, { width: pw * 0.65 - 16, align: 'right' });
  y += hdrH;

  // ── Blue title bar ──
  doc.rect(ml, y, pw, 18).fill('#1565C0');
  doc.fillColor('#fff').fontSize(10).font('Helvetica-Bold').text(t.ticket_id || '', ml + 10, y + 4);
  doc.fontSize(7).font('Helvetica').text('Date: ' + formatDate(t.created_at), ml + pw - 100, y + 4, { width: 90, align: 'right' });
  y += 18;

  // ── CUSTOMER DETAILS ──
  sectionTitle('CUSTOMER DETAILS');
  const custBodyTop = sectionBody();
  drawFieldRow([
    { label: 'Customer Name', value: t.customer_name || '' },
    { label: 'Mobile', value: t.customer_phone || '' },
  ]);
  const fullAddr2 = [t.customer_address, t.city, t.state].filter(Boolean).join(', ');
  doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#888');
  doc.text('ADDRESS', ml + 8, y, { width: pw - 16 });
  doc.fontSize(8).font('Helvetica').fillColor('#333');
  doc.text(fullAddr2 || '', ml + 8, y + 9, { width: pw - 16 });
  y += 22;
  endSection(custBodyTop, 8);

  // ── DEVICE DETAILS ──
  sectionTitle('DEVICE DETAILS');
  const devBodyTop = sectionBody();
  drawFieldRow([
    { label: 'Brand', value: t.brand || '' },
    { label: 'Model', value: t.model || '' },
  ]);
  drawFieldRow([
    { label: 'Serial Number', value: t.serial_number || '' },
    { label: 'Warranty', value: t.warranty || '—' },
  ]);
  drawFieldRow([
    { label: 'Device Type', value: t.device_type || '' },
    { label: 'Service Type', value: t.issue_category || t.issue || '' },
  ]);
  endSection(devBodyTop, 8);

  // ── PROBLEM DETAILS ──
  sectionTitle('PROBLEM DETAILS');
  const probBodyTop = sectionBody();
  doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#888');
  doc.text('CUSTOMER COMPLAINT', ml + 8, y, { width: pw - 16 });
  doc.fontSize(8).font('Helvetica').fillColor('#333');
  doc.text(t.issue_category || t.issue || '', ml + 8, y + 9, { width: pw - 16 });
  const pcH = doc.heightOfString(t.issue_category || t.issue || '', { width: pw - 16 }) + 12;
  y += Math.max(22, pcH);
  doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#888');
  doc.text('ISSUE FOUND', ml + 8, y, { width: pw - 16 });
  doc.fontSize(8).font('Helvetica').fillColor('#333');
  doc.text(t.problem_description || t.issue || '', ml + 8, y + 9, { width: pw - 16 });
  const piH = doc.heightOfString(t.problem_description || t.issue || '', { width: pw - 16 }) + 12;
  y += Math.max(22, piH);
  doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#888');
  doc.text('SOLUTION', ml + 8, y, { width: pw - 16 });
  doc.fontSize(8).font('Helvetica').fillColor('#333');
  doc.text(t.repair_description || t.solution_description || '', ml + 8, y + 9, { width: pw - 16 });
  const psH = doc.heightOfString(t.repair_description || t.solution_description || '', { width: pw - 16 }) + 12;
  y += Math.max(22, psH);
  endSection(probBodyTop, 8);

  // ── ACCESSORIES ──
  sectionTitle('ACCESSORIES');
  const accBodyTop = sectionBody();
  const accLabels = ['Charger', 'Adapter', 'Mouse', 'Keyboard', 'Battery', 'Bag', 'Power Cable', 'HDMI Cable', 'Other: _________'];
  const accText = accLabels.map(l => '\u2610 ' + l).join('    ');
  doc.fontSize(7).font('Helvetica').fillColor('#666');
  doc.text(accText, ml + 8, y + 2, { width: pw - 16 });
  y += 16;
  endSection(accBodyTop, 8);

  // ── DEVICE CONDITION ──
  const condBodyTop = y;
  const estCost = parseFloat(t.estimated_cost || t.estimatedCost || 0);
  doc.rect(ml, y, pw, 20).stroke('#D9D9D9');
  doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#888');
  doc.text('BODY DAMAGE', ml + 8, y + 3, { width: pw / 3 - 12 });
  doc.text('DATA BACKUP', ml + pw / 3 + 4, y + 3, { width: pw / 3 - 12 });
  doc.text('ESTIMATE PRICE', ml + pw * 2 / 3 + 4, y + 3, { width: pw / 3 - 12 });
  doc.fontSize(8).font('Helvetica').fillColor('#333');
  doc.text(t.body_damage || t.bodyDamage || 'No', ml + 8, y + 11, { width: pw / 3 - 12 });
  doc.text(t.data_backup || t.dataBackup || 'No', ml + pw / 3 + 4, y + 11, { width: pw / 3 - 12 });
  doc.text(estCost > 0 ? '\u20B9' + estCost.toFixed(0) : '', ml + pw * 2 / 3 + 4, y + 11, { width: pw / 3 - 12 });
  y += 20;

  // ── TERMS ──
  const termsTxt = 'TERMS & CONDITIONS: 1. Product warranty subject to company policy. 2. Data backup is customer\'s responsibility. 3. Repair warranty valid for 30 days. 4. Inspection charges applicable. 5. Device must be collected within 30 days. 6. Service center not responsible for accessories after 30 days.';
  const termsH = doc.heightOfString(termsTxt, { width: pw - 20 }) + 12;
  doc.rect(ml, y, pw, termsH).stroke('#D9D9D9');
  doc.fontSize(6).font('Helvetica').fillColor('#666');
  doc.text(termsTxt, ml + 8, y + 4, { width: pw - 16 });
  y += termsH;

  // ── SIGNATURES ──
  const sigH = 48;
  doc.rect(ml, y, pw / 2 - 3, sigH).stroke('#D9D9D9');
  doc.rect(ml + pw / 2 + 3, y, pw / 2 - 3, sigH).stroke('#D9D9D9');
  doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#1565C0');
  doc.text('CUSTOMER', ml + 8, y + 4, { width: pw / 2 - 14 });
  doc.fontSize(6).font('Helvetica').fillColor('#666');
  doc.text('\u2610 I have received my device in good condition.\n\u2610 I have collected my device and approve closure.', ml + 8, y + 14, { width: pw / 2 - 14 });
  doc.moveTo(ml + 12, y + sigH - 10).lineTo(ml + pw / 2 - 12, y + sigH - 10).dash(1, { space: 1 }).stroke('#ccc');
  doc.undash();
  doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#888');
  doc.text('Customer Signature', ml + 8, y + sigH - 9, { width: pw / 2 - 14, align: 'center' });
  doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#1565C0');
  doc.text('SERVICE CENTER', ml + pw / 2 + 11, y + 4, { width: pw / 2 - 14 });
  doc.fontSize(6).font('Helvetica').fillColor('#666');
  doc.text(store.company_name || 'SERVICE CENTER', ml + pw / 2 + 11, y + 14, { width: pw / 2 - 14, align: 'center' });
  doc.moveTo(ml + pw / 2 + 15, y + sigH - 10).lineTo(ml + pw - 15, y + sigH - 10).dash(1, { space: 1 }).stroke('#ccc');
  doc.undash();
  doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#888');
  doc.text('Authorized Signature', ml + pw / 2 + 11, y + sigH - 9, { width: pw / 2 - 14, align: 'center' });
  y += sigH;

  // ── Footer ──
  y = Math.min(y + 8, doc.page.height - 30);
  doc.fontSize(6).fillColor('#aaa');
  doc.text('Computer-generated repair order. Generated on ' + new Date().toLocaleString('en-IN'), ml, y, { align: 'center' });

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', async () => {
      const stats = fs.statSync(filePath);
      resolve({ filePath, fileName, fileSize: stats.size, receiptNumber: `RCPT-${t.ticket_id}` });
    });
    stream.on('error', reject);
  });
}

async function generateInvoicePdf(invoiceId) {
  const iRes = await query('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
  if (iRes.rows.length === 0) throw new Error('Invoice not found');
  const inv = iRes.rows[0];

  const itemsRes = await query('SELECT * FROM invoice_items WHERE invoice_id = $1', [invoiceId]);
  const items = itemsRes.rows;

  const tRes = inv.ticket_id ? await query('SELECT * FROM tickets WHERE id = $1', [inv.ticket_id]) : { rows: [] };
  const ticket = tRes.rows[0] || {};

  const cRes = await query('SELECT * FROM store_settings LIMIT 1');
  const store = cRes.rows[0] || {};

  const dir = path.join(PDF_DIR, 'invoices');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const fileName = `Invoice_${inv.invoice_id}.pdf`;
  const filePath = path.join(dir, fileName);

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const pageWidth = doc.page.width - 100;
  let y = 50;

  // Header
  if (store.logo && fs.existsSync(path.join(__dirname, '../../', store.logo))) {
    doc.image(path.join(__dirname, '../../', store.logo), 50, y, { width: 80 });
  }
  doc.fontSize(20).font('Helvetica-Bold').fillColor('#1a1a1a').text('INVOICE', 150, y, { align: 'center' });
  doc.fontSize(8).font('Helvetica').fillColor('#666')
    .text([store.company_name || 'Repair Shop', store.address, store.city ? `${store.city}, ${store.state || ''}` : '', `GST: ${store.gst_vat || ''}`].filter(Boolean).join('\n'), 150, y + 25, { align: 'center' });

  y += 70;

  // Invoice Info
  doc.moveTo(50, y).lineTo(pageWidth + 50, y).stroke('#ccc');
  y += 15;

  doc.fontSize(9).font('Helvetica-Bold').fillColor('#333');
  const labels = ['Invoice No:', 'Date:', 'Due Date:', 'Payment Terms:', 'Status:'];
  const values = [inv.invoice_id, formatDate(inv.issue_date), formatDate(inv.due_date), inv.payment_terms || 'Net 14 days', inv.status];

  labels.forEach((label, i) => {
    doc.text(label, 50, y);
    doc.font('Helvetica').text(values[i], 120, y);
    y += 15;
    doc.font('Helvetica-Bold');
  });

  y += 10;

  // Bill To
  doc.moveTo(50, y).lineTo(pageWidth + 50, y).stroke('#ddd');
  y += 10;
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a1a1a').text('Bill To:', 50, y);
  y += 18;
  doc.fontSize(9).font('Helvetica').fillColor('#333');
  const billToLines = [
    inv.billed_to_name || inv.customer_name || '—',
    inv.billed_to_address1 || '',
    inv.billed_to_address2 || '',
    `Phone: ${inv.customer_phone || ''}`,
    `Email: ${inv.customer_email || ''}`,
  ].filter(Boolean);
  billToLines.forEach(line => { doc.text(line, 50, y); y += 14; });

  y = Math.max(y, 180);

  // Device Info
  if (ticket.device_type) {
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#555').text('Device:', 50, y);
    doc.font('Helvetica').fillColor('#333').text(`${ticket.brand || ''} ${ticket.model || ''} (${ticket.device_type || ''})`, 110, y);
    y += 16;
    doc.font('Helvetica-Bold').fillColor('#555').text('Serial:', 50, y);
    doc.font('Helvetica').fillColor('#333').text(ticket.serial_number || '—', 110, y);
    y += 20;
  }

  // Items Table
  doc.moveTo(50, y).lineTo(pageWidth + 50, y).stroke('#ddd');
  y += 8;
  const tableTop = y;
  const colX = [50, 120, 340, 390, 440, 500];
  const colW = [70, 220, 50, 50, 60, 50];
  const headers = ['#', 'Item', 'Qty', 'Rate', 'Tax', 'Total'];

  doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff');
  doc.rect(50, y, pageWidth, 18).fill('#333');
  doc.fill('#fff');
  headers.forEach((h, i) => doc.text(h, colX[i] + 4, y + 4, { width: colW[i] }));
  y += 18;

  doc.fontSize(8).font('Helvetica').fillColor('#333');
  let rowNum = 0;
  (items.length > 0 ? items : [{ name: inv.service || 'Repair Service', quantity: 1, unit_price: inv.total_amount || 0, tax_rate: inv.tax_rate || 0, total: inv.total_amount || 0 }]).forEach(item => {
    const rowY = y;
    const cols = [
      String(++rowNum),
      item.name || 'Service',
      String(item.quantity || 1),
      formatCurrency(item.unit_price || 0),
      `${item.tax_rate || 0}%`,
      formatCurrency(item.total || 0),
    ];
    if (rowNum % 2 === 0) doc.rect(50, rowY, pageWidth, 16).fill('#f9f9f9');
    cols.forEach((c, i) => {
      doc.fillColor('#333').text(c, colX[i] + 4, rowY + 3, { width: colW[i] });
    });
    y += 16;
  });

  // Totals
  y += 5;
  const totalX = pageWidth - 180;
  const totalLabelX = totalX + 50;
  doc.fontSize(9).font('Helvetica').fillColor('#555');
  const totalRows = [
    ['Subtotal:', inv.subtotal],
    ['Tax:', inv.tax_amount],
    ['Discount:', inv.discount],
  ];
  totalRows.forEach(([label, val]) => {
    doc.text(label, totalLabelX, y);
    doc.text(formatCurrency(val || 0), totalLabelX + 80, y, { align: 'right', width: 70 });
    y += 16;
  });

  doc.moveTo(totalLabelX, y).lineTo(totalLabelX + 150, y).stroke('#ccc');
  y += 8;
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a1a1a');
  doc.text('Total Amount:', totalLabelX, y);
  doc.text(formatCurrency(inv.total_amount || 0), totalLabelX + 80, y, { align: 'right', width: 70 });

  y += 20;
  doc.fontSize(9).font('Helvetica').fillColor('#555');
  doc.text(`Amount Paid: ${formatCurrency(inv.amount_paid || 0)}`, totalLabelX, y);
  y += 14;
  doc.font('Helvetica-Bold').fillColor(inv.balance_due > 0 ? '#d32f2f' : '#2e7d32');
  doc.text(`Balance Due: ${formatCurrency(inv.balance_due || 0)}`, totalLabelX, y);

  // Payment Details
  if (inv.payment_method) {
    y += 25;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#555').text('Payment Method:', 50, y);
    doc.font('Helvetica').fillColor('#333').text(inv.payment_method, 150, y);
    y += 16;
  }

  // Warranty
  if (ticket.warranty) {
    y += 5;
    doc.fontSize(8).font('Helvetica').fillColor('#555').text(
      `Warranty: ${ticket.warranty_period || '90'} days from ${formatDate(ticket.actual_completion_date || ticket.created_at)}`,
      50, y
    );
  }

  // Notes
  if (inv.notes) {
    y += 20;
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#555').text('Notes:', 50, y);
    y += 12;
    doc.font('Helvetica').fillColor('#333').text(inv.notes, 50, y, { width: pageWidth });
  }

  // Footer
  y = doc.page.height - 60;
  doc.fontSize(7).fillColor('#999').text(`Generated on ${new Date().toLocaleString('en-IN')}`, 50, y, { align: 'center' });
  doc.text('This is a computer-generated invoice.', 50, y + 12, { align: 'center' });

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => {
      const stats = fs.statSync(filePath);
      resolve({ filePath, fileName, fileSize: stats.size });
    });
    stream.on('error', reject);
  });
}

async function generateOrderPdf(orderId) {
  const oRes = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (oRes.rows.length === 0) throw new Error('Order not found');
  const order = oRes.rows[0];

  const cRes = await query('SELECT * FROM store_settings LIMIT 1');
  const store = cRes.rows[0] || {};

  const compRes = await query('SELECT * FROM order_components WHERE order_id = $1', [orderId]);
  const components = compRes.rows || [];

  const dir = path.join(PDF_DIR, 'orders');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const fileName = `Order_Inward_${order.order_number}.pdf`;
  const filePath = path.join(dir, fileName);

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const ml = 40;
  const pw = doc.page.width - ml * 2;
  let y = 40;

  function sectionTitle(text) {
    doc.rect(ml, y, pw, 16).fill('#F5F7FA');
    doc.fillAndStroke('#1565C0', '#D9D9D9');
    doc.rect(ml, y, pw, 16).stroke('#D9D9D9');
    doc.fillColor('#1565C0').fontSize(8).font('Helvetica-Bold').text(text.toUpperCase(), ml + 8, y + 4);
    y += 16;
  }

  function sectionBody() {
    return y;
  }

  function endSection(bodyTop) {
    doc.rect(ml, bodyTop, pw, y - bodyTop).stroke('#D9D9D9');
  }

  function drawFieldRow(cols) {
    const n = cols.length;
    const cw = (pw - 16) / n;
    let maxH = 0;
    const positions = cols.map((c, i) => {
      const x = ml + 8 + i * cw;
      doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#888');
      doc.text(c.label.toUpperCase(), x, y, { width: cw - 4 });
      doc.fontSize(8).font('Helvetica').fillColor('#333');
      const val = c.value || '';
      doc.text(val, x, y + 9, { width: cw - 4 });
      const vh = doc.heightOfString(val, { width: cw - 4 }) + 9;
      maxH = Math.max(maxH, vh);
      return { x, w: cw };
    });
    y += maxH + 4;
  }

  // ── HEADER ──
  const hdrH = 60;
  doc.rect(ml, y, pw, hdrH).stroke('#D9D9D9');
  doc.moveTo(ml + pw * 0.35, y).lineTo(ml + pw * 0.35, y + hdrH).stroke('#D9D9D9');
  if (store.logo && fs.existsSync(path.join(__dirname, '../../', store.logo))) {
    try { doc.image(path.join(__dirname, '../../', store.logo), ml + 8, y + 4, { width: 50 }); } catch (e) { /* skip */ }
  }
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#1565C0');
  doc.text(store.company_name || 'REPAIR SHOP', ml + 8, y + hdrH - 18, { width: pw * 0.35 - 16 });
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1565C0');
  doc.text('REPAIR ORDER', ml + pw * 0.35 + 8, y + 6, { width: pw * 0.65 - 16, align: 'right' });
  doc.fontSize(6.5).font('Helvetica').fillColor('#666');
  const addrParts = [store.address, [store.city, store.state].filter(Boolean).join(', ')].filter(Boolean);
  doc.text(addrParts.join(', ') + (store.pincode ? ' - ' + store.pincode : ''), ml + pw * 0.35 + 8, y + 22, { width: pw * 0.65 - 16, align: 'right' });
  doc.text('Phone: ' + (store.phone || ''), ml + pw * 0.35 + 8, y + 33, { width: pw * 0.65 - 16, align: 'right' });
  doc.text('GST: ' + (store.gst_vat || 'N/A'), ml + pw * 0.35 + 8, y + 44, { width: pw * 0.65 - 16, align: 'right' });
  y += hdrH;

  // ── Blue title bar ──
  doc.rect(ml, y, pw, 18).fill('#1565C0');
  doc.fillColor('#fff').fontSize(10).font('Helvetica-Bold').text(order.order_number || '', ml + 10, y + 4);
  doc.fontSize(7).font('Helvetica').text('Date: ' + formatDate(order.order_date), ml + pw - 100, y + 4, { width: 90, align: 'right' });
  y += 18;

  // ── CUSTOMER DETAILS ──
  sectionTitle('CUSTOMER DETAILS');
  const custBodyTop = sectionBody();
  drawFieldRow([
    { label: 'Customer Name', value: order.customer_name || '' },
    { label: 'Mobile', value: order.mobile_number || '' },
  ]);
  doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#888');
  doc.text('ADDRESS', ml + 8, y, { width: pw - 16 });
  doc.fontSize(8).font('Helvetica').fillColor('#333');
  doc.text(order.address || '', ml + 8, y + 9, { width: pw - 16 });
  y += 22;
  endSection(custBodyTop);

  // ── DEVICE DETAILS ──
  sectionTitle('DEVICE DETAILS');
  const devBodyTop = sectionBody();
  drawFieldRow([
    { label: 'Brand', value: order.brand || '' },
    { label: 'Model', value: order.model || '' },
  ]);
  drawFieldRow([
    { label: 'Serial Number', value: order.serial_number || '' },
    { label: 'Warranty', value: '—' },
  ]);
  drawFieldRow([
    { label: 'Device Type', value: (order.device_type || '') + (order.desktop_type ? ' (' + order.desktop_type + ')' : '') },
    { label: 'Service Type', value: 'Repair' },
  ]);
  endSection(devBodyTop);

  // ── PROBLEM DETAILS ──
  sectionTitle('PROBLEM DETAILS');
  const probBodyTop = sectionBody();
  doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#888');
  doc.text('CUSTOMER COMPLAINT', ml + 8, y, { width: pw - 16 });
  doc.fontSize(8).font('Helvetica').fillColor('#333');
  doc.text(order.problem_description || '', ml + 8, y + 9, { width: pw - 16 });
  const pcH = doc.heightOfString(order.problem_description || '', { width: pw - 16 }) + 12;
  y += Math.max(22, pcH);
  endSection(probBodyTop);

  // ── COMPONENTS ──
  if (components.length > 0) {
    sectionTitle('COMPONENTS');
    const compBodyTop = sectionBody();
    doc.rect(ml + 8, y, pw - 16, 14).fill('#1565C0');
    doc.fillColor('#fff').fontSize(7).font('Helvetica-Bold');
    const compCols = ['Component', 'Qty', 'Status', 'Remarks'];
    const compW = (pw - 16) / 4;
    compCols.forEach((h, i) => doc.text(h, ml + 10 + i * compW, y + 3, { width: compW - 4 }));
    y += 14;
    components.forEach((c, idx) => {
      if (idx % 2 === 0) doc.rect(ml + 8, y, pw - 16, 16).fill('#F9FAFB');
      doc.fillColor('#333').fontSize(7).font('Helvetica');
      const vals = [c.component_name, String(c.quantity || 1), c.status || 'present', c.remarks || ''];
      vals.forEach((v, i) => doc.text(v, ml + 10 + i * compW, y + 4, { width: compW - 4 }));
      y += 16;
    });
    endSection(compBodyTop);
  }

  // ── PAYMENT SUMMARY ──
  sectionTitle('PAYMENT SUMMARY');
  const payBodyTop = sectionBody();
  doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#888');
  const payCols = ['Service', 'Advance Paid', 'Total', 'Status'];
  const payVals = [
    formatCurrency(order.service_amount || 0),
    formatCurrency(order.advance_payment || 0),
    formatCurrency(order.total_amount || 0),
    order.payment_status || 'Unpaid',
  ];
  const payW = (pw - 16) / 4;
  payCols.forEach((h, i) => doc.text(h.toUpperCase(), ml + 8 + i * payW, y, { width: payW - 4 }));
  y += 9;
  doc.fontSize(8).font('Helvetica-Bold').fillColor('#1565C0');
  payVals.forEach((v, i) => {
    if (i === 1) doc.fillColor('#2E7D32');
    else if (i === 3) doc.fillColor(order.remaining_balance > 0 ? '#F9A825' : '#2E7D32');
    else doc.fillColor('#1565C0');
    doc.text(v, ml + 8 + i * payW, y, { width: payW - 4 });
  });
  doc.fillColor('#333');
  y += 14;
  endSection(payBodyTop);

  // ── TERMS ──
  const termsTxt = 'TERMS & CONDITIONS: 1. Product warranty subject to company policy. 2. Data backup is customer\'s responsibility. 3. Repair warranty valid for 30 days. 4. Inspection charges applicable. 5. Device must be collected within 30 days. 6. Service center not responsible for accessories after 30 days.';
  const termsH = doc.heightOfString(termsTxt, { width: pw - 20 }) + 12;
  doc.rect(ml, y, pw, termsH).stroke('#D9D9D9');
  doc.fontSize(6).font('Helvetica').fillColor('#666');
  doc.text(termsTxt, ml + 8, y + 4, { width: pw - 16 });
  y += termsH;

  // ── SIGNATURES ──
  const sigH = 48;
  doc.rect(ml, y, pw / 2 - 3, sigH).stroke('#D9D9D9');
  doc.rect(ml + pw / 2 + 3, y, pw / 2 - 3, sigH).stroke('#D9D9D9');
  doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#1565C0');
  doc.text('CUSTOMER', ml + 8, y + 4, { width: pw / 2 - 14 });
  doc.fontSize(6).font('Helvetica').fillColor('#666');
  doc.text('\u2610 I have received my device in good condition.\n\u2610 I have collected my device and approve closure.', ml + 8, y + 14, { width: pw / 2 - 14 });
  doc.moveTo(ml + 12, y + sigH - 10).lineTo(ml + pw / 2 - 12, y + sigH - 10).dash(1, { space: 1 }).stroke('#ccc');
  doc.undash();
  doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#888');
  doc.text('Customer Signature', ml + 8, y + sigH - 9, { width: pw / 2 - 14, align: 'center' });
  doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#1565C0');
  doc.text('SERVICE CENTER', ml + pw / 2 + 11, y + 4, { width: pw / 2 - 14 });
  doc.fontSize(6).font('Helvetica').fillColor('#666');
  doc.text(store.company_name || 'SERVICE CENTER', ml + pw / 2 + 11, y + 14, { width: pw / 2 - 14, align: 'center' });
  doc.moveTo(ml + pw / 2 + 15, y + sigH - 10).lineTo(ml + pw - 15, y + sigH - 10).dash(1, { space: 1 }).stroke('#ccc');
  doc.undash();
  doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#888');
  doc.text('Authorized Signature', ml + pw / 2 + 11, y + sigH - 9, { width: pw / 2 - 14, align: 'center' });
  y += sigH;

  // ── Footer ──
  y = Math.min(y + 8, doc.page.height - 30);
  doc.fontSize(6).fillColor('#aaa');
  doc.text('Computer-generated repair order. Generated on ' + new Date().toLocaleString('en-IN'), ml, y, { align: 'center' });

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => {
      const stats = fs.statSync(filePath);
      resolve({ filePath, fileName, fileSize: stats.size });
    });
    stream.on('error', reject);
  });
}

async function generateInwardReceiptFromHTML(ticketId) {
  const tRes = await query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
  if (tRes.rows.length === 0) throw new Error('Ticket not found');
  const ticket = tRes.rows[0];

  const cRes = await query('SELECT * FROM store_settings LIMIT 1');
  const store = cRes.rows[0] || {};

  const dir = path.join(PDF_DIR, 'inward');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const fileName = `Inward_Receipt_${ticket.ticket_id}.pdf`;
  const filePath = path.join(dir, fileName);

  let html = populateInwardTemplate(ticket, store);

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
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });
  } finally {
    await browser.close();
  }

  const stats = fs.statSync(filePath);
  return { filePath, fileName, fileSize: stats.size, receiptNumber: `RCPT-${ticket.ticket_id}` };
}

module.exports = { generateInwardReceipt, generateInwardReceiptFromHTML, generateInvoicePdf, generateOrderPdf };
