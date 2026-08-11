const fs = require('fs');
const path = require('path');

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric'
    });
  } catch { return ''; }
}

function fmtCurrency(amount) {
  const val = parseFloat(amount) || 0;
  return '\u20B9' + val.toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

function resolveLogoSrc(logo) {
  if (!logo) return '';
  if (typeof logo === 'string' && logo.startsWith('data:')) return logo;
  const logoAbsPath = path.join(__dirname, '../..', logo);
  if (fs.existsSync(logoAbsPath)) {
    const ext = path.extname(logo).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.svg' ? 'image/svg+xml' : 'image/jpeg';
    const buf = fs.readFileSync(logoAbsPath);
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  }
  return '';
}

function buildCompanyAddress(settings) {
  const parts = [
    settings.address,
    [settings.city, settings.state].filter(Boolean).join(', '),
    settings.pincode ? settings.pincode : '',
  ].filter(Boolean);
  return esc(parts.join(', '));
}

function buildCompanyContact(settings) {
  const lines = [];
  if (settings.phone || settings.mobile) lines.push('<div class="company-line">Phone: ' + esc(settings.phone || settings.mobile) + '</div>');
  if (settings.email) lines.push('<div class="company-line">Email: ' + esc(settings.email) + '</div>');
  if (settings.gst_vat || settings.gst_number) lines.push('<div class="company-line">GST: ' + esc(settings.gst_vat || settings.gst_number) + '</div>');
  return lines.join('');
}

function buildBilledTo(ticket) {
  const name = [ticket.company, ticket.customer_name].filter(Boolean).join(', ');
  const address = [ticket.service_address, [ticket.city, ticket.state].filter(Boolean).join(', '), ticket.postcode].filter(Boolean).join(', ');
  const contact = [ticket.customer_phone, ticket.customer_email].filter(Boolean).join(', ');
  const rows = [];
  if (name) rows.push('<div class="billed-row"><span class="billed-key">Name</span><span class="billed-val">' + esc(name) + '</span></div>');
  if (address) rows.push('<div class="billed-row"><span class="billed-key">Address</span><span class="billed-val">' + esc(address) + '</span></div>');
  if (contact) rows.push('<div class="billed-row"><span class="billed-key">Contact</span><span class="billed-val">' + esc(contact) + '</span></div>');
  return '<div class="billed-to-box"><div class="billed-label">BILLED TO</div><div class="billed-info">' + rows.join('') + '</div></div>';
}

function normalizeItems(ticket, items) {
  const out = [];
  if (Array.isArray(items)) {
    items.forEach(function (raw) {
      if (!raw) return;
      const description = raw.description || raw.name || raw.item || raw.desc || '';
      if (!String(description).trim()) return;
      const qty = parseFloat(raw.qty ?? raw.quantity ?? raw.unit ?? 1) || 1;
      const unitPrice = parseFloat(raw.unitPrice ?? raw.unit_price ?? raw.price ?? 0) || 0;
      const total = parseFloat(raw.total ?? raw.amount ?? 0);
      out.push({
        description: String(description).trim(),
        qty,
        unitPrice,
        total: Number.isFinite(total) ? total : qty * unitPrice,
      });
    });
  }

  if (out.length === 0) {
    // Fallback: split the work description into individual line items.
    const source = ticket.solution_description || ticket.problem_description || '';
    const lines = String(source).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length > 0) {
      lines.forEach(line => {
        out.push({ description: line, qty: 1, unitPrice: 0, total: 0 });
      });
    } else {
      out.push({ description: 'Service / Repair', qty: 1, unitPrice: 0, total: 0 });
    }
  }

  return out;
}

function buildItemsRows(items) {
  let rows = '';
  items.forEach(function (item, idx) {
    const price = parseFloat(item.unitPrice) || 0;
    const qty = parseFloat(item.qty) || 1;
    const total = parseFloat(item.total) || 0;
    rows += '<tr>' +
      '<td class="c-srno">' + (idx + 1) + '</td>' +
      '<td class="c-desc">' + esc(item.description) + '</td>' +
      '<td class="c-qty">' + qty + '</td>' +
      '<td class="c-price">' + fmtCurrency(price) + '</td>' +
      '<td class="c-total">' + fmtCurrency(total) + '</td>' +
      '</tr>';
  });
  return rows;
}

function buildTotalsRows(subtotal, taxAmount, discount, grandTotal) {
  let html = '';
  html += '<tr class="total-row"><td class="total-label">Sub Total</td><td class="total-value">' + fmtCurrency(subtotal) + '</td></tr>';
  html += '<tr class="grand-total-row"><td class="total-label">Grand Total</td><td class="total-value">' + fmtCurrency(grandTotal) + '</td></tr>';
  return html;
}

function buildTotals(subtotal, taxRate, discount, ticket) {
  const taxAmount = parseFloat(taxRate) > 0 ? subtotal * (parseFloat(taxRate) / 100) : 0;
  const disc = parseFloat(discount) || 0;
  let grandTotal = subtotal + taxAmount - disc;
  if (grandTotal <= 0) {
    grandTotal = parseFloat(ticket.total_amount || ticket.estimated_cost || ticket.estimated_price || 0) || subtotal;
  }
  return { subtotal, taxAmount, discount: disc, grandTotal };
}

function populateServiceInvoiceTemplate(ticket, settings, options) {
  const companyName = settings.company_name || settings.store_name || 'BLUECHIP COMPUTER SYSTEM';
  const invoiceNumber = (options && options.invoiceNumber) || ('SI-' + (ticket.ticket_id || ticket.id));
  const invoiceDate = fmtDate((options && options.invoiceDate) || ticket.actual_completion_date || new Date());

  const items = normalizeItems(ticket, options && options.items);
  const totals = buildTotals(
    items.reduce((sum, it) => sum + (parseFloat(it.total) || 0), 0),
    options && options.taxRate !== undefined ? options.taxRate : (ticket.tax_rate || 0),
    options && options.discount !== undefined ? options.discount : (ticket.discount || 0),
    ticket
  );

  const logoSrc = resolveLogoSrc(settings.logo);
  const logoHtml = logoSrc
    ? '<img class="logo" src="' + logoSrc + '" alt="Logo" />'
    : '';

  const companyAddr = buildCompanyAddress(settings);
  const companyContact = buildCompanyContact(settings);
  const billedToHtml = buildBilledTo(ticket);
  const deviceModel = [ticket.brand, ticket.model].filter(Boolean).join(' ');
  const notes = (ticket.solution_description || ticket.technician_diagnosis || ticket.job_notes || '').trim();

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Service Invoice - ${esc(invoiceNumber)}</title>
  <style>
    @page { size: A4 portrait; margin: 12mm 12mm 16mm 12mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Arial, Helvetica, sans-serif;
      font-size: 10pt;
      color: #1a1a1a;
      line-height: 1.4;
    }
    .page-header {
      position: fixed;
      top: 0;
      left: 12mm;
      right: 12mm;
      padding-bottom: 12px;
    }
    .header {
      display: flex;
      align-items: stretch;
      height: 116px;
      border-bottom: 2px solid #1565C0;
    }
    .header-logo {
      width: 20%;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 12px;
    }
    .logo { max-height: 86px; max-width: 90%; object-fit: contain; }
    .header-company {
      width: 50%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 8px 18px 8px 0;
      border-right: 2px solid #1565C0;
    }
    .company-name { font-size: 13pt; font-weight: bold; color: #202124; text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 4px; }
    .company-line { font-size: 8pt; color: #5f6368; line-height: 1.35; }
    .header-invoice {
      width: 30%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 8px 0 8px 18px;
    }
    .doc-title { font-size: 12.5pt; font-weight: bold; color: #1565C0; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 4px; }
    .doc-meta { font-size: 9pt; color: #202124; margin-top: 4px; }
    .doc-meta .k { color: #5f6368; }
    .content { padding-top: 138px; padding-bottom: 104px; }

    .section-label {
      font-size: 8.5pt; font-weight: bold; letter-spacing: 0.8px; color: #1565C0;
      text-transform: uppercase; border-bottom: 1px solid #dadce0; padding-bottom: 3px; margin: 16px 0 8px;
    }

    .billed-to-box {
      display: flex;
      border: 1px solid #dadce0;
      border-radius: 6px;
      overflow: hidden;
    }
    .billed-label {
      width: 110px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10pt;
      font-weight: bold;
      color: #1565C0;
      background: #f0f6ff;
      border-right: 1px solid #dadce0;
      letter-spacing: 0.8px;
      text-transform: uppercase;
    }
    .billed-info { flex: 1; padding: 8px 12px; }
    .billed-row { display: flex; padding: 2px 0; font-size: 9.5pt; line-height: 1.45; }
    .billed-row + .billed-row { border-top: 1px dashed #eceff1; margin-top: 2px; padding-top: 4px; }
    .billed-key { width: 76px; flex-shrink: 0; font-weight: bold; color: #202124; }
    .billed-key::after { content: " :"; }
    .billed-val { flex: 1; color: #202124; word-wrap: break-word; overflow-wrap: break-word; }

    table.device { width: 100%; border-collapse: collapse; table-layout: fixed; }
    table.device th {
      background: #1565C0; color: #fff; font-size: 8.5pt; font-weight: bold;
      text-align: left; padding: 7px 8px; text-transform: uppercase; letter-spacing: 0.5px;
      border: 1px solid #1150a0;
    }
    table.device td {
      border: 1px solid #dadce0; padding: 8px; font-size: 9.5pt; vertical-align: middle;
      word-break: break-word;
    }

    table.items { width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 4px; }
    table.items thead { display: table-header-group; }
    table.items th {
      background: #1565C0; color: #fff; font-size: 8.5pt; font-weight: bold;
      padding: 7px 8px; text-align: left; text-transform: uppercase; letter-spacing: 0.5px;
      border: 1px solid #1150a0;
    }
    table.items td {
      border: 1px solid #dadce0; padding: 7px 8px; font-size: 9pt; vertical-align: middle;
      word-wrap: break-word; overflow-wrap: break-word;
    }
    .c-srno { width: 6%; text-align: center; }
    .c-desc { width: 48%; text-align: left; }
    .c-qty { width: 10%; text-align: center; }
    .c-price { width: 18%; text-align: right; }
    .c-total { width: 18%; text-align: right; }

    table.totals { width: 48%; border-collapse: collapse; margin-left: auto; margin-top: 12px; }
    table.totals td { border: 1px solid #dadce0; padding: 7px 10px; font-size: 9.5pt; }
    .total-label { font-weight: bold; color: #5f6368; }
    .total-value { text-align: right; font-weight: bold; color: #202124; }
    .grand-total-row td { background: #e8f0fe; font-weight: bold; color: #1565C0; font-size: 11pt; }
    .grand-total-row .total-label { color: #1565C0; }

    .notes-box { border: 1px solid #dadce0; border-radius: 6px; padding: 8px 10px; font-size: 9pt; color: #202124; }

    .page-footer {
      position: fixed;
      bottom: 10mm;
      left: 12mm;
      right: 12mm;
      border-top: 2px solid #1565C0;
      padding-top: 10px;
      text-align: center;
      color: #202124;
    }
    .footer-company { font-size: 11pt; font-weight: bold; color: #1565C0; text-transform: uppercase; letter-spacing: 0.5px; }
    .sign-area { margin-top: 26px; }
    .sign-line { width: 58%; margin: 0 auto; border-top: 1px solid #9aa0a6; }
    .sign-label { margin-top: 5px; font-size: 8.5pt; color: #5f6368; }
  </style>
</head>
<body>
  <div class="page-header">
    <div class="header">
      <div class="header-logo">
        ${logoHtml}
      </div>
      <div class="header-company">
        <div class="company-name">${esc(companyName)}</div>
        ${companyAddr ? '<div class="company-line">' + companyAddr + '</div>' : ''}
        ${companyContact}
      </div>
      <div class="header-invoice">
        <div class="doc-title">Service Invoice</div>
        <div class="doc-meta"><span class="k">Invoice No :</span> <strong>${esc(invoiceNumber)}</strong></div>
        <div class="doc-meta"><span class="k">Invoice Date :</span> <strong>${esc(invoiceDate)}</strong></div>
      </div>
    </div>
  </div>

  <div class="content">
    ${billedToHtml}

    <div class="section-label">Device Information</div>
    <table class="device">
      <thead>
        <tr>
          <th style="width:25%">Date</th>
          <th style="width:45%">Computer Model</th>
          <th style="width:30%">Serial Number</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${esc(invoiceDate)}</td>
          <td>${esc(deviceModel || '—')}</td>
          <td>${esc(ticket.serial_number || ticket.serial_imei || '—')}</td>
        </tr>
      </tbody>
    </table>

    <div class="section-label">Items / Services</div>
    <table class="items">
      <thead>
        <tr>
          <th class="c-srno">SR NO</th>
          <th class="c-desc">Item / Service Description</th>
          <th class="c-qty">Qty</th>
          <th class="c-price">Unit Price</th>
          <th class="c-total">Total</th>
        </tr>
      </thead>
      <tbody>
        ${buildItemsRows(items)}
      </tbody>
    </table>

    <table class="totals">
      <tbody>
        ${buildTotalsRows(totals.subtotal, totals.taxAmount, totals.discount, totals.grandTotal)}
      </tbody>
    </table>

    ${notes ? `
    <div class="section-label">Notes</div>
    <div class="notes-box">${esc(notes)}</div>` : ''}
  </div>

  <div class="page-footer">
    <div class="footer-company">${esc(companyName)}</div>
    <div class="sign-area">
      <div class="sign-line"></div>
      <div class="sign-label">Authorized Signature</div>
    </div>
  </div>
</body>
</html>`;
}

module.exports = { populateServiceInvoiceTemplate };
