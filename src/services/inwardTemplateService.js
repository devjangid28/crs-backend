const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', '..', 'inward.html');

function fmt(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric'
    });
  } catch { return ''; }
}

function populateInwardTemplate(ticket, settings) {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(`Template file not found at ${TEMPLATE_PATH}`);
  }

  let html = fs.readFileSync(TEMPLATE_PATH, 'utf-8');

  const companyName  = settings.company_name || '';
  const tagline      = settings.tagline || '';

  if (settings.logo) {
    let logoSrc = '';
    if (typeof settings.logo === 'string' && settings.logo.startsWith('data:')) {
      logoSrc = settings.logo;
    } else {
      const logoAbsPath = path.join(__dirname, '../..', settings.logo);
      if (fs.existsSync(logoAbsPath)) {
        logoSrc = 'file:///' + logoAbsPath.replace(/\\/g, '/').replace(/^\/?/, '');
      }
    }
    if (logoSrc) {
      const logoImgHtml = `<img src="${logoSrc}" alt="Logo" style="max-width:140px;max-height:80px;object-fit:contain;" />`;
      html = html.replace(
        /<div class="logo">[^<]*<\/div>\s*<div class="logo-subtitle">[^<]*<\/div>/,
        logoImgHtml
      );
    } else {
      html = html.replace(
        /<div class="logo">[^<]*<\/div>/,
        `<div class="logo">${companyName || 'REPAIR SHOP'}</div>`
      );
      html = html.replace(
        /<div class="logo-subtitle">[^<]*<\/div>/,
        `<div class="logo-subtitle">${tagline}</div>`
      );
    }
  } else {
    html = html.replace(
      /<div class="logo">[^<]*<\/div>/,
      `<div class="logo">${companyName || 'REPAIR SHOP'}</div>`
    );
    html = html.replace(
      /<div class="logo-subtitle">[^<]*<\/div>/,
      `<div class="logo-subtitle">${tagline}</div>`
    );
  }

  const addressParts = [
    settings.address,
    [settings.city, settings.state].filter(Boolean).join(', '),
    settings.pincode,
  ].filter(Boolean);
  const phoneLine = settings.phone || '';
  let addressHtml = addressParts.join('<br>');
  if (phoneLine) addressHtml += '<br>' + phoneLine;

  html = html.replace(
    /<p>[^]*?<\/p>/,
    `<p>${addressHtml}</p>`
  );

  html = html.replace(
    /(INWARD NO\.\s*:<\/span>\s*)[^<]*(?=<)/,
    `$1${ticket.ticket_id || ticket.id || ''}`
  );

  html = html.replace(
    /(DATE\s*:<\/span>\s*)[^<]*(?=<)/,
    `$1${fmt(ticket.created_at)}`
  );

  html = html.replace(
    /(SERVICE TYPE\s*:<\/span><br>)[^<]*(?=<)/,
    `$1${ticket.issue_category || ''}`
  );

  html = html.replace(
    /(BRAND\s*:<\/span>\s*)[^<]*(?=<)/,
    `$1${ticket.brand || ''}`
  );

  const custAddr = [
    ticket.customer_name,
    ticket.customer_address,
    ticket.city,
    ticket.pincode,
  ].filter(Boolean).join(', ');

  html = html.replace(
    /(CUSTOMER NAME & ADDRESS\s*:<\/span><br>)[^<]*(?=<)/,
    `$1${custAddr || ''}`
  );

  html = html.replace(
    /(MODEL No\.<\/span>\s*)[^<]*(?=<)/,
    `$1${ticket.model || ''}`
  );

  html = html.replace(
    /(<span class="field-label">SERIAL NO\.<\/span>)\s*/,
    `$1 ${ticket.serial_number || ''}`
  );

  html = html.replace(
    /WARRANTY\s*(YES|NO)?/,
    `WARRANTY ${ticket.warranty ? 'YES' : 'NO'}`
  );

  html = html.replace(
    /(CUSTOMER MOBILE\s*:<\/span>\s*)[^<]*(?=<)/,
    `$1${ticket.customer_phone || ''}`
  );

  html = html.replace(
    /(CUSTOMER COMPLAINT\s*:<\/span>\s*)[^<]*(?=<)/,
    `$1${ticket.problem_description || ''}`
  );

  html = html.replace(
    /(ISSUE IF ANY\s*:<\/span>\s*)[^<]*(?=<)/,
    `$1${ticket.issue || ticket.problem_description || ''}`
  );

  html = html.replace(
    /(ACCESSORY LIST\s*:<\/span>)/,
    `$1 ${ticket.accessories || ''}`
  );

  html = html.replace(
    /(BODY DAMAGE\s*:<\/span>\s*)[^<]*(?=<)/,
    `$1${ticket.body_damage || 'NO'}`
  );

  html = html.replace(
    /(DATA BACKUP\s*:<\/span>\s*)[^<]*(?=<)/,
    `$1${ticket.data_backup || 'NO'}`
  );

  const estCost = parseFloat(ticket.estimated_price || ticket.estimatedPrice || ticket.estimated_cost || ticket.estimatedCost || 0);
  html = html.replace(
    /(ESTIMATE PRICE\s*:<\/span>)/,
    `$1${estCost > 0 ? ' \u20B9' + estCost.toFixed(2) : ''}`
  );

  // Replace footer company name with store name
  const footerName = companyName || 'REPAIR SHOP';
  html = html.replace(
    /(<div class="footer-right">)[^<]*(<br>)/,
    `$1${footerName}$2`
  );

  return html;
}

module.exports = { populateInwardTemplate };
