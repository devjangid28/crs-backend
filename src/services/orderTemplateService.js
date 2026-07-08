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
  const deviceBrand = order.brand || '';
  const modelStr = order.model || '---';
  const serialStr = order.serial_number || '';
  const modelSerial = modelStr + (serialStr ? ' / ' + serialStr : '');

  html = html.replace(
    /(<td[^>]*id="deviceBrand"[^>]*>)[^<]*(<\/td>)/,
    '$1' + deviceBrand + '$2'
  );
  html = html.replace(
    /(<td[^>]*id="modelSerial"[^>]*>)[^<]*(<\/td>)/,
    '$1' + modelSerial + '$2'
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

  // ── FINANCIAL CALCULATIONS ──
  const componentsTotal = components ? components.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0) : 0;
  const serviceAmt = parseFloat(order.service_amount) || 0;
  const disc = parseFloat(order.discount) || 0;
  const subtotal = serviceAmt + componentsTotal;
  const gstRate = 0.18;
  const gstAmount = subtotal * gstRate;
  const amountBeforeDiscount = subtotal + gstAmount;
  const grandTotal = amountBeforeDiscount - disc;
  const advance = parseFloat(order.advance_payment) || 0;
  const remainingBalance = Math.max(0, grandTotal - advance);

  // ── PAYMENT SUMMARY (left column — values) ──
  html = html.replace(
    /(<[^>]*\sid="serviceAmount"[^>]*>)[^<]*(<\/\w+>)/,
    '$1' + fmtCurrency(serviceAmt) + '$2'
  );
  const advanceMode = order.advance_payment_mode || '';
  const advanceLabel = advance > 0
    ? fmtCurrency(advance) + (advanceMode ? ' (' + advanceMode + ')' : '')
    : fmtCurrency(advance);
  html = html.replace(
    /(<[^>]*\sid="advancePaid"[^>]*>)[^<]*(<\/\w+>)/,
    '$1' + advanceLabel + '$2'
  );
  html = html.replace(
    /(<[^>]*\sid="totalAmount"[^>]*>)[^<]*(<\/\w+>)/,
    '$1' + fmtCurrency(grandTotal) + '$2'
  );
  html = html.replace(
    /(<[^>]*\sid="paySubtotal"[^>]*>)[^<]*(<\/\w+>)/,
    '$1' + fmtCurrency(subtotal) + '$2'
  );
  html = html.replace(
    /(<[^>]*\sid="payGstAmount"[^>]*>)[^<]*(<\/\w+>)/,
    '$1' + fmtCurrency(gstAmount) + '$2'
  );
  html = html.replace(
    /(<[^>]*\sid="payDiscount"[^>]*>)[^<]*(<\/\w+>)/,
    '$1' + fmtCurrency(disc) + '$2'
  );
  html = html.replace(
    /(<[^>]*\sid="remainingBalance"[^>]*>)[^<]*(<\/\w+>)/,
    '$1' + fmtCurrency(remainingBalance) + '$2'
  );
  html = html.replace(
    /(<[^>]*\sid="paymentStatus"[^>]*>)[^<]*(<\/\w+>)/,
    '$1' + (order.payment_status || 'Unpaid') + '$2'
  );
  html = html.replace(
    /(<[^>]*\sid="paymentMode"[^>]*>)[^<]*(<\/\w+>)/,
    '$1' + (order.payment_type || 'Cash') + '$2'
  );

  // ── SPECIFICATIONS ──
  let specs = order.specifications;
  if (typeof specs === 'string') { try { specs = JSON.parse(specs); } catch { specs = null; } }
  if (specs && Array.isArray(specs) && specs.length > 0) {
    let specRows = '';
    specs.forEach(function(s) {
      if (s.spec || s.value) {
        specRows += '<tr><td class="label">' + (s.spec || '') + '</td><td class="value">' + (s.value || '') + '</td></tr>';
      }
    });
    if (specRows) {
      html = html.replace(
        /<tbody id="specificationsBody">[\s\S]*?<\/tbody>/,
        '<tbody id="specificationsBody">' + specRows + '</tbody>'
      );
      html = html.replace(
        /(id="specificationsSection")\s*style="display:none;"/,
        'id="specificationsSection" style="display:block;"'
      );
    }
  }

  // ── WATERMARK ──
  let watermarkSrc = '';
  const watermarkPath = path.join(__dirname, '..', '..', '..', 'public', 'watermark.png');
  if (fs.existsSync(watermarkPath)) {
    const buf = fs.readFileSync(watermarkPath);
    watermarkSrc = 'data:image/png;base64,' + buf.toString('base64');
  }
  html = html.replace(
    /(<div class="watermark"[^>]*id="watermark"[^>]*>)[\s\S]*?(<\/div>)/,
    '$1<img src="' + watermarkSrc + '" alt="" id="watermarkImg" />$2'
  );

  // ── GENERATED DATE ──
  const now = new Date().toLocaleString('en-IN');
  html = html.replace(
    /(<div class="generated-text"[^>]*id="generatedText"[^>]*>)[^<]*(<\/div>)/,
    '$1Computer-generated sales order confirmation. Generated on ' + now + '$2'
  );

  return html;
}

module.exports = { populateOrderTemplate };
