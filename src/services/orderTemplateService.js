const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', '..', 'orderform.html');

function fmt(d) {
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

function populateOrderTemplate(order, components, settings) {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error('Template file not found at ' + TEMPLATE_PATH);
  }

  let html = fs.readFileSync(TEMPLATE_PATH, 'utf-8');

  const companyName = settings.company_name || 'BLUECHIP COMPUTER SYSTEM';

  // ── LOGO ──
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
  const logoSrc = resolveLogoSrc(settings.logo);
  if (logoSrc) {
    const logoImg = '<img src="' + logoSrc + '" alt="Logo" style="max-width:140px;max-height:80px;object-fit:contain;" />';
    html = html.replace(
      /<div class="logo-placeholder"[^>]*id="companyLogo"[^>]*>[\s\S]*?<\/div>\s*<\/div>/,
      '<div class="logo-placeholder" id="companyLogo">' + logoImg + '</div>'
    );
  } else {
    html = html.replace(
      /<div class="logo-text"[^>]*id="logoText"[^>]*>[^<]*<\/div>/,
      '<div class="logo-text" id="logoText">' + companyName + '</div>'
    );
  }

  // ── COMPANY DETAILS ──
  html = html.replace(
    /(<div class="company-name"[^>]*id="companyName"[^>]*>)[^<]*(<\/div>)/,
    '$1' + (settings.company_name || 'BLUECHIP COMPUTER SYSTEM') + '$2'
  );

  const addressParts = [
    settings.address,
    [settings.city, settings.state].filter(Boolean).join(', '),
    settings.pincode ? settings.pincode : '',
  ].filter(Boolean);

  let addrLine = addressParts.join('<br>');
  const phoneParts = [];
  if (settings.phone) phoneParts.push('Phone: ' + settings.phone);
  if (settings.email) phoneParts.push('Email: ' + settings.email);
  if (phoneParts.length) addrLine += '<br>' + phoneParts.join(' | ');
  if (settings.gst_vat) addrLine += '<br>GST: ' + settings.gst_vat;

  html = html.replace(
    /(<div class="company-address"[^>]*id="companyAddress"[^>]*>)[\s\S]*?(<\/div>)/,
    '$1' + addrLine + '$2'
  );

  // ── ORDER HEADER ──
  html = html.replace(
    /(<div id="orderId">)[^<]*(<\/div>)/,
    '$1' + (order.order_number || '') + '$2'
  );

  html = html.replace(
    /(<div id="orderDate">)[^<]*(<\/div>)/,
    '$1Date: ' + fmt(order.order_date || order.created_at) + '$2'
  );

  // ── CUSTOMER DETAILS ──
  html = html.replace(
    /(<div[^>]*id="customerName"[^>]*>)[^<]*(<\/div>)/,
    '$1' + (order.customer_name || '') + '$2'
  );
  html = html.replace(
    /(<div[^>]*id="customerMobile"[^>]*>)[^<]*(<\/div>)/,
    '$1' + (order.mobile_number || '') + '$2'
  );
  html = html.replace(
    /(<div[^>]*id="customerAddress"[^>]*>)[^<]*(<\/div>)/,
    '$1' + (order.address || '') + '$2'
  );

  // ── DEVICE DETAILS ──
  let deviceBrand = order.brand || '';
  if (order.device_type) {
    deviceBrand = order.device_type + (deviceBrand ? ' (' + deviceBrand + ')' : '');
  }

  html = html.replace(
    /(<div[^>]*id="deviceBrand"[^>]*>)[^<]*(<\/div>)/,
    '$1' + deviceBrand + '$2'
  );
  html = html.replace(
    /(<div[^>]*id="deviceModel"[^>]*>)[^<]*(<\/div>)/,
    '$1' + (order.model || '---') + '$2'
  );
  html = html.replace(
    /(<div[^>]*id="serialNumber"[^>]*>)[^<]*(<\/div>)/,
    '$1' + (order.serial_number || '') + '$2'
  );

  // ── COMPONENTS TABLE ──
  if (components && components.length > 0) {
    let rows = '';
    components.forEach(function(c, idx) {
      const amount = parseFloat(c.amount || 0).toFixed(2);
      const price = parseFloat(c.price || 0).toFixed(2);
      rows += '<tr><td>' + (idx + 1) + '</td><td>' + (c.component_name || '') + '</td><td>' + (c.description || '') + '</td><td>' + (c.warranty || '') + '</td><td>' + (c.quantity || 1) + '</td><td>' + price + '</td><td>' + amount + '</td></tr>';
    });
    html = html.replace(
      /<tbody id="componentsTable">[\s\S]*?<\/tbody>/,
      '<tbody id="componentsTable">' + rows + '</tbody>'
    );
  }

  // ── PAYMENT SUMMARY ──
  const componentsTotal = components ? components.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0) : 0;
  const subtotal = (parseFloat(order.service_amount) || 0) + componentsTotal;
  const gstAmount = subtotal * 0.18;
  const grandTotal = subtotal + gstAmount - (parseFloat(order.discount) || 0);

  html = html.replace(
    /(<div[^>]*id="serviceAmount"[^>]*>)[^<]*(<\/div>)/,
    '$1' + fmtCurrency(order.service_amount || 0) + '$2'
  );
  html = html.replace(
    /(<div[^>]*id="partsAmount"[^>]*>)[^<]*(<\/div>)/,
    '$1' + fmtCurrency(order.parts_amount || 0) + '$2'
  );
  html = html.replace(
    /(<div[^>]*id="advancePaid"[^>]*>)[^<]*(<\/div>)/,
    '$1' + fmtCurrency(order.advance_payment || 0) + '$2'
  );
  html = html.replace(
    /(<div[^>]*id="totalAmount"[^>]*>)[^<]*(<\/div>)/,
    '$1' + fmtCurrency(order.total_amount || 0) + '$2'
  );
  html = html.replace(
    /(<div[^>]*id="discountAmount"[^>]*>)[^<]*(<\/div>)/,
    '$1' + fmtCurrency(order.discount || 0) + '$2'
  );
  html = html.replace(
    /(<div[^>]*id="paymentStatus"[^>]*>)[^<]*(<\/div>)/,
    '$1' + (order.payment_status || 'Unpaid') + '$2'
  );

  // New enhanced financial fields
  const gstFormatted = gstAmount.toFixed(2);
  const subtotalFormatted = subtotal.toFixed(2);
  const componentsTotalFormatted = componentsTotal.toFixed(2);
  const grandTotalFormatted = grandTotal.toFixed(2);

  html = html.replace(
    /(<div[^>]*id="componentsTotal"[^>]*>)[^<]*(<\/div>)/,
    '$1' + fmtCurrency(componentsTotal) + '$2'
  );
  html = html.replace(
    /(<div[^>]*id="subtotalAmount"[^>]*>)[^<]*(<\/div>)/,
    '$1' + fmtCurrency(subtotal) + '$2'
  );
  html = html.replace(
    /(<div[^>]*id="gstAmount"[^>]*>)[^<]*(<\/div>)/,
    '$1' + fmtCurrency(gstAmount) + '$2'
  );
  html = html.replace(
    /(<div[^>]*id="grandTotal"[^>]*>)[^<]*(<\/div>)/,
    '$1' + fmtCurrency(grandTotal) + '$2'
  );

  // ── SERVICE CENTER NAME IN FOOTER ──
  html = html.replace(
    /(<div class="center-name"[^>]*id="centerName"[^>]*>)[^<]*(<\/div>)/,
    '$1' + companyName + '$2'
  );

  // ── GENERATED DATE ──
  const now = new Date().toLocaleString('en-IN');
  html = html.replace(
    /(<div class="generated-text"[^>]*id="generatedText"[^>]*>)[^<]*(<\/div>)/,
    '$1Computer-generated repair order. Generated on ' + now + '$2'
  );

  return html;
}

module.exports = { populateOrderTemplate };
