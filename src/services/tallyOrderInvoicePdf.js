const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { query } = require('../config/database');

const PDF_DIR = path.join(__dirname, '../../uploads/pdfs/invoice-orders');
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

function isAsusStore(name) {
  return String(name || '').toLowerCase().includes('asus');
}

function fmtINR(v) {
  return (parseFloat(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  const dd = String(dt.getDate()).padStart(2, '0');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return dd + '-' + months[dt.getMonth()] + '-' + dt.getFullYear();
}

const scodes = { 'Gujarat':'24','Maharashtra':'27','Rajasthan':'08','Madhya Pradesh':'23','Karnataka':'29','Tamil Nadu':'33','Delhi':'07','Uttar Pradesh':'09','West Bengal':'19','Haryana':'06','Punjab':'03','Bihar':'10','Odisha':'21','Telangana':'36','Kerala':'32','Andhra Pradesh':'37','Chhattisgarh':'22','Jharkhand':'20','Uttarakhand':'05','Himachal Pradesh':'02','Assam':'18','Goa':'30','Sikkim':'11' };
const stateCode = (s) => scodes[s] || '24';

const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
const tensArr = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
function formatCurrency(n) { if(n===0)return''; if(n<20)return ones[n]; if(n<100)return tensArr[Math.floor(n/10)]+(n%10?' '+ones[n%10]:''); return ones[Math.floor(n/100)]+' Hundred'+(n%100?' and '+formatCurrency(n%100):''); }
function convert(n) { if(n===0)return''; if(n<1000)return formatCurrency(n); if(n<100000)return formatCurrency(Math.floor(n/1000))+' Thousand'+(n%1000?' '+convert(n%1000):''); if(n<10000000)return formatCurrency(Math.floor(n/100000))+' Lakh'+(n%100000?' '+convert(n%100000):''); return formatCurrency(Math.floor(n/10000000))+' Crore'+(n%10000000?' '+convert(n%10000000):''); }
function numToWords(num) { const i=Math.floor(num); const d=Math.round((num-i)*100); let r='INR '+convert(i); if(d>0)r+=' and '+formatCurrency(d)+' Paise'; return r+' Only'; }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Inline backend-hosted image (store.logo) as a data URI so puppeteer renders it.
function resolveImgSrc(logo) {
  if (!logo) return '';
  if (typeof logo === 'string' && (logo.startsWith('data:') || logo.startsWith('http'))) return logo;
  const abs = path.join(__dirname, '../..', logo);
  try {
    if (fs.existsSync(abs)) {
      const ext = path.extname(logo).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.svg' ? 'image/svg+xml' : 'image/jpeg';
      return 'data:' + mime + ';base64,' + fs.readFileSync(abs).toString('base64');
    }
  } catch (e) { /* ignore */ }
  return '';
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

// Mirrors buildOrderInvoiceItems in ManageOrders.jsx
function buildOrderInvoiceItems(order, components) {
  const items = [];
  const accessoryName = order.accessory_type === 'Custom' ? (order.custom_accessory || 'Custom Accessory') : (order.accessory_type || '');
  const svcAmt = parseFloat(order.service_amount) || 0;
  if (svcAmt > 0) {
    items.push({
      name: order.device_type === 'Accessories' ? `Accessories${accessoryName ? ' - ' + accessoryName : ''}` : `${order.device_type || ''}${order.brand ? ' - ' + order.brand + ' ' + (order.model || '') : ''}`,
      description: order.problem_description || '',
      qty: 1,
      price: svcAmt,
      serialNumber: order.serial_number || '',
      tax: 18,
      hsn: '',
      batch: '',
      warranty: '',
      discount: 0,
    });
  }
  (Array.isArray(components) ? components : []).forEach(comp => {
    const compPrice = parseFloat(comp.price) || 0;
    const compQty = comp.quantity || 1;
    const compAmount = parseFloat(comp.amount) || (compPrice * compQty);
    if (compAmount > 0 || compQty > 0) {
      items.push({
        name: comp.component_name || 'Component',
        description: comp.description || comp.remarks || '',
        qty: compQty,
        price: compPrice || (compAmount / compQty),
        serialNumber: '',
        tax: 18,
        hsn: '',
        batch: '',
        warranty: comp.warranty || '',
        discount: 0,
      });
    }
  });
  if (items.length === 0 && (parseFloat(order.total_amount) || 0) > 0) {
    items.push({
      name: order.device_type === 'Accessories' ? `Accessories${accessoryName ? ' - ' + accessoryName : ''}` : `${order.device_type || ''}${order.brand ? ' - ' + order.brand : ''}`,
      description: order.problem_description || order.order_note || '',
      qty: 1,
      price: parseFloat(order.total_amount) || 0,
      serialNumber: order.serial_number || '',
      tax: 18,
      hsn: '',
      batch: '',
      warranty: '',
      discount: 0,
    });
  }
  return items;
}

function buildInvoiceHTML(order, components, store) {
  const taxRate = 18;
  const cgstRate = taxRate / 2;
  const sgstRate = taxRate / 2;
  const isAsus = isAsusStore(store.store_name);

  const items = buildOrderInvoiceItems(order, components);

  const lineTotals = items.map((i) => {
    const qty = parseInt(i.qty) || 1;
    const rate = parseFloat(i.price) || 0;
    const disc = parseFloat(i.discount || 0);
    const lineIncl = Math.max(0, (rate - disc) * qty);
    if (isAsus) {
      const taxable = lineIncl / (1 + taxRate / 100);
      const tax = lineIncl - taxable;
      return { qty, rate, disc, taxable, cgst: tax / 2, sgst: tax / 2, total: lineIncl };
    }
    const taxable = lineIncl;
    return { qty, rate, disc, taxable, cgst: taxable * cgstRate / 100, sgst: taxable * sgstRate / 100, total: taxable + taxable * taxRate / 100 };
  });

  const taxableValue = lineTotals.reduce((s, l) => s + l.taxable, 0);
  const cgstAmount = lineTotals.reduce((s, l) => s + l.cgst, 0);
  const sgstAmount = lineTotals.reduce((s, l) => s + l.sgst, 0);
  const totalTax = cgstAmount + sgstAmount;
  const amountBeforeRound = lineTotals.reduce((s, l) => s + l.total, 0);
  const grandTotal = Math.round(amountBeforeRound);

  const companyName = store.company_name || 'BLUECHIP COMPUTER SYSTEM';
  const addr = store.address || '';
  const city = store.city || '';
  const state = store.state || 'Gujarat';
  const pincode = store.pincode || '';
  const gstin = store.gst_number || store.gst_vat || '';
  const emailAddr = store.email || '';
  const phoneNum = store.phone || '';
  const pan = store.pan || '';
  const logoSrc = resolveImgSrc(store.logo);

  const custName = order.customer_name || 'Walk-in Customer';
  const custAddr = order.address || '';
  const custState = state || 'Gujarat';
  const custPhone = order.mobile_number || '';
  const custEmail = order.email || '';
  const custGstin = order.gstin || '';
  const custPin = order.pincode || pincode || '';
  const custCity = city || 'Vadodara';

  const terms = order.payment_type || 'Cash';
  const orderNumber = order.order_number || '';
  const invoiceDate = fmtDate(order.order_date || new Date());

  const financeDown = parseFloat(order.finance_down_payment || 0) || 0;
  const financeEmi = parseFloat(order.finance_emi || 0) || 0;
  const financeDur = parseInt(order.finance_duration, 10) || 0;
  const isFinance = terms === 'Finance' || order.payment_type === 'Finance';

  let asusCompanyName = companyName;
  let asusAddr = addr;
  let asusPhone = phoneNum;
  let asusEmail = emailAddr;
  let asusWebsite = '';
  if (isAsus) {
    asusCompanyName = 'ASUS EXCLUSIVE STORE';
    asusAddr = '05, Harmony complex, Opp. MK High School, Alkapuri, Vadodara-07';
    asusPhone = '9904991114';
    asusEmail = 'bluechipcs@yahoo.com';
    asusWebsite = 'www.bccsgroup.in';
  }

  const declarationTerms = store.terms_conditions ||
    'We declare that this Invoice shows the actual price of the goods described and that all particulars are true and correct. Interest @24% Condition: Subject to Vadodara Jurisdiction. Material once sold will be taken back or exchanged only under company policy. Warranty: 12 months against mfg defects as per terms of payment. For asus regulations to claim in after please go onto www.asus.com/in within 7 days of the invoice date & pay. SUBJECT TO ASUS TOLL FREE NO: 1800-2090-365 JURISDICTION';

  // Embed the stamp & sign as an inline data URI so puppeteer renders it without a server.
  const stampPath = path.join(__dirname, '../../public/stamp-sign.jpg');
  let stampImg = '';
  try {
    if (fs.existsSync(stampPath)) {
      const ext = path.extname(stampPath).slice(1).toLowerCase() === 'png' ? 'png' : 'jpeg';
      stampImg = `<img src="data:image/${ext};base64,${fs.readFileSync(stampPath).toString('base64')}" alt="Stamp & Sign" style="max-width:100px;max-height:60px;object-fit:contain;margin:0 auto 4px;" />`;
    }
  } catch (e) {
    stampImg = '';
  }

  const itemRows = items.map((item, idx) => {
    const lt = lineTotals[idx] || { qty: 1, taxable: 0, cgst: 0, sgst: 0, total: 0 };
    const qty = lt.qty;
    const rate = isAsus ? (lt.taxable / qty) : lt.rate;
    const itemTaxRate = item.tax || taxRate;
    const hsn = item.hsn || '84713010';
    const descLines = [
      `<div style="font-weight:bold">${esc(item.name || 'Service')}</div>`,
      item.batch ? `<div>Batch: ${esc(item.batch)}</div>` : '',
      item.serialNumber ? `<div>S/N: ${esc(item.serialNumber)}</div>` : '',
      item.warranty ? `<div>${esc(item.warranty)}</div>` : '',
      item.description ? `<div style="font-size:7.5px">${esc(item.description)}</div>` : '',
    ].filter(Boolean).join('');
    return `<tr>
      <td style="border:1px solid #777;padding:2px 3px;text-align:center;vertical-align:top">${idx + 1}</td>
      <td style="border:1px solid #777;padding:2px 4px;vertical-align:top">${descLines}</td>
      <td style="border:1px solid #777;padding:2px 3px;text-align:center;vertical-align:top">${esc(hsn)}</td>
      <td style="border:1px solid #777;padding:2px 3px;text-align:center;vertical-align:top">${qty} Qty</td>
      <td style="border:1px solid #777;padding:2px 3px;text-align:right;vertical-align:top">${fmtINR(rate)}</td>
      <td style="border:1px solid #777;padding:2px 3px;text-align:right;vertical-align:top">${fmtINR(lt.taxable)}</td>
      <td style="border:1px solid #777;padding:2px 3px;text-align:center;vertical-align:top">${itemTaxRate / 2}%</td>
      <td style="border:1px solid #777;padding:2px 3px;text-align:right;vertical-align:top">${fmtINR(lt.cgst)}</td>
      <td style="border:1px solid #777;padding:2px 3px;text-align:center;vertical-align:top">${itemTaxRate / 2}%</td>
      <td style="border:1px solid #777;padding:2px 3px;text-align:right;vertical-align:top">${fmtINR(lt.sgst)}</td>
      <td style="border:1px solid #777;padding:2px 3px;text-align:right;vertical-align:top;font-weight:bold">${fmtINR(lt.total)}</td>
    </tr>`;
  }).join('');

  const taxSummaryRows = items.map((item, idx) => {
    const lt = lineTotals[idx] || { taxable: 0, cgst: 0, sgst: 0 };
    const itr = item.tax || taxRate;
    return `<tr>
      <td style="border:1px solid #777;text-align:center">${esc(item.hsn || '84713010')}</td>
      <td style="border:1px solid #777;text-align:right">${fmtINR(lt.taxable)}</td>
      <td style="border:1px solid #777;text-align:center">${itr / 2}%</td>
      <td style="border:1px solid #777;text-align:right">${fmtINR(lt.cgst)}</td>
      <td style="border:1px solid #777;text-align:center">${itr / 2}%</td>
      <td style="border:1px solid #777;text-align:right">${fmtINR(lt.sgst)}</td>
      <td style="border:1px solid #777;text-align:right">${fmtINR(lt.cgst + lt.sgst)}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html><head><title>Invoice ${orderNumber}</title>
<style>
@page{size:A4 portrait;margin:8mm}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;font-size:9px;color:#000;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{width:100%;min-height:280mm;padding:0;margin:0 auto;background:#fff;display:flex;flex-direction:column}
table{border-collapse:collapse}
.bd{border:1px solid #777}
td,th{font-size:8px;padding:2px 3px;vertical-align:top}
.lbl{font-weight:bold;background:#f5f5f5}
.tr{text-align:right}
.tc{text-align:center}
.tl{text-align:left}
.bold{font-weight:bold}
</style></head><body>
<div class="page">
<div style="text-align:center;font-size:11px;font-weight:bold;padding:3px 0;border:1px solid #777;border-bottom:none">Tax Invoice</div>
<table style="width:100%;border:1px solid #777">
<tr>
  <td style="width:60%;border-right:1px solid #777;padding:4px 5px;vertical-align:top">
    <table style="width:100%"><tr>
      <td style="width:60px;vertical-align:top;padding-right:6px">
        ${logoSrc ? `<img src="${esc(logoSrc)}" style="max-width:110px;max-height:120px;object-fit:contain" />` : ''}
      </td>
      <td style="vertical-align:top">
        <div style="font-size:9px;font-weight:bold;line-height:1.4">${esc(asusCompanyName)}</div>
        <div style="font-size:7.5px;line-height:1.6">
          ${asusAddr ? `<div>${esc(asusAddr)}</div>` : ''}
          ${asusPhone ? `<div>Ph: ${esc(asusPhone)}</div>` : ''}
          ${asusEmail ? `<div>E-Mail: ${esc(asusEmail)}</div>` : ''}
          ${asusWebsite ? `<div>${esc(asusWebsite)}</div>` : ''}
          ${gstin ? `<div>GSTIN/UIN: ${esc(gstin)}</div>` : ''}
          ${pan ? `<div>PAN: ${esc(pan)}</div>` : ''}
          <div>State: ${esc(state)}, Code: ${stateCode(state)}</div>
        </div>
      </td>
    </tr></table>
  </td>
  <td style="width:40%;padding:0;vertical-align:top">
    <table style="width:100%">
      <tr><td style="border-bottom:1px solid #777;border-right:1px solid #777;padding:2px 4px" class="lbl">Invoice No.</td><td style="border-bottom:1px solid #777;padding:2px 4px">${esc(terms === 'Finance' ? 'FIN-' : 'INV-')}${esc(orderNumber)}</td></tr>
      <tr><td style="border-bottom:1px solid #777;border-right:1px solid #777;padding:2px 4px" class="lbl">Dated</td><td style="border-bottom:1px solid #777;padding:2px 4px">${invoiceDate}</td></tr>
      <tr><td style="border-bottom:1px solid #777;border-right:1px solid #777;padding:2px 4px" class="lbl">Delivery Note</td><td style="border-bottom:1px solid #777;padding:2px 4px"></td></tr>
      <tr><td style="border-bottom:1px solid #777;border-right:1px solid #777;padding:2px 4px" class="lbl">Mode/Terms of Payment</td><td style="border-bottom:1px solid #777;padding:2px 4px">${esc(terms)}${isFinance ? '<br/><span style="font-size:6.5px">Finance: Down ' + fmtINR(financeDown) + ' + EMI ' + fmtINR(financeEmi) + '/mo for ' + financeDur + ' months</span>' : ''}</td></tr>
      <tr><td style="border-bottom:1px solid #777;border-right:1px solid #777;padding:2px 4px" class="lbl">Reference No. &amp; Date</td><td style="border-bottom:1px solid #777;padding:2px 4px">${esc(orderNumber)} / ${invoiceDate}</td></tr>
      <tr><td style="border-bottom:1px solid #777;border-right:1px solid #777;padding:2px 4px" class="lbl">Buyer's Order No.</td><td style="border-bottom:1px solid #777;padding:2px 4px">${esc(orderNumber)}</td></tr>
      <tr><td style="border-bottom:1px solid #777;border-right:1px solid #777;padding:2px 4px" class="lbl">Dispatch Doc No.</td><td style="border-bottom:1px solid #777;padding:2px 4px"></td></tr>
      <tr><td style="border-bottom:1px solid #777;border-right:1px solid #777;padding:2px 4px" class="lbl">Delivery Note Date</td><td style="border-bottom:1px solid #777;padding:2px 4px"></td></tr>
      <tr><td style="border-bottom:1px solid #777;border-right:1px solid #777;padding:2px 4px" class="lbl">Dispatched through</td><td style="border-bottom:1px solid #777;padding:2px 4px"></td></tr>
      <tr><td style="border-right:1px solid #777;padding:2px 4px" class="lbl">Destination</td><td style="padding:2px 4px">${esc(custCity)}</td></tr>
    </table>
  </td>
</tr>
</table>
<table style="width:100%;border:1px solid #777;border-top:none">
<tr>
  <td style="width:50%;border-right:1px solid #777;padding:3px 5px;vertical-align:top">
    <div style="font-weight:bold;font-size:8px;margin-bottom:2px">Consignee (Ship To)</div>
    <div style="font-size:8px;line-height:1.6">
      <div class="bold">${esc(custName)}</div>
      ${custAddr ? `<div>${esc(custAddr)}</div>` : ''}
      ${custCity ? `<div>${esc(custCity)}${custPin ? ' - ' + esc(custPin) : ''}</div>` : ''}
      <div>State: ${esc(custState)}, Code: ${stateCode(custState)}</div>
      ${custGstin ? `<div>GSTIN/UIN: ${esc(custGstin)}</div>` : ''}
      ${custPhone ? `<div>Contact: ${esc(custPhone)}</div>` : ''}
      ${custEmail ? `<div>E-Mail: ${esc(custEmail)}</div>` : ''}
    </div>
  </td>
  <td style="width:50%;padding:3px 5px;vertical-align:top">
    <div style="font-weight:bold;font-size:8px;margin-bottom:2px">Buyer (Bill To)</div>
    <div style="font-size:8px;line-height:1.6">
      <div class="bold">${esc(custName)}</div>
      ${custAddr ? `<div>${esc(custAddr)}</div>` : ''}
      ${custCity ? `<div>${esc(custCity)}${custPin ? ' - ' + esc(custPin) : ''}</div>` : ''}
      <div>State: ${esc(custState)}, Code: ${stateCode(custState)}</div>
      ${custGstin ? `<div>GSTIN/UIN: ${esc(custGstin)}</div>` : ''}
      ${custPhone ? `<div>Contact: ${esc(custPhone)}</div>` : ''}
      ${custEmail ? `<div>E-Mail: ${esc(custEmail)}</div>` : ''}
      <div>Place of Supply: ${esc(custState || 'Gujarat')}</div>
    </div>
  </td>
</tr>
</table>
<table style="width:100%;border:1px solid #777;border-top:none">
<thead>
<tr style="background:#f5f5f5">
  <th style="border:1px solid #777;width:3%;text-align:center">Sl No.</th>
  <th style="border:1px solid #777;width:28%;text-align:center">Description of Goods</th>
  <th style="border:1px solid #777;width:7%;text-align:center">HSN/SAC</th>
  <th style="border:1px solid #777;width:6%;text-align:center">Quantity</th>
  <th style="border:1px solid #777;width:8%;text-align:center">Rate (Excl. Tax)</th>
  <th style="border:1px solid #777;width:9%;text-align:center">Taxable Value</th>
  <th style="border:1px solid #777;width:5%;text-align:center">CGST %</th>
  <th style="border:1px solid #777;width:7%;text-align:center">CGST Amt</th>
  <th style="border:1px solid #777;width:5%;text-align:center">SGST %</th>
  <th style="border:1px solid #777;width:7%;text-align:center">SGST Amt</th>
  <th style="border:1px solid #777;width:9%;text-align:center">Amount</th>
</tr>
</thead>
<tbody>
${itemRows || '<tr><td colspan="11" style="border:1px solid #777;padding:2px 3px;text-align:center">No items</td></tr>'}
<tr><td colspan="11" style="border:1px solid #777;height:35mm"></td></tr>
<tr>
  <td colspan="5" style="border:1px solid #777;padding:2px 4px;font-weight:bold">Total</td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right;font-weight:bold">${fmtINR(taxableValue)}</td>
  <td style="border:1px solid #777"></td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right;font-weight:bold">${fmtINR(cgstAmount)}</td>
  <td style="border:1px solid #777"></td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right;font-weight:bold">${fmtINR(sgstAmount)}</td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right;font-weight:bold">&#8377;${fmtINR(grandTotal)}</td>
</tr>
</tbody>
</table>
<div style="border:1px solid #777;border-top:none;padding:3px 5px;display:flex;justify-content:space-between">
  <div><span style="font-weight:bold">Amount Chargeable (in words): </span>${numToWords(grandTotal)}</div>
  <div style="font-style:italic;font-size:7.5px">E. &amp; O.E</div>
</div>
<table style="width:100%;border:1px solid #777;border-top:none">
<thead>
<tr style="background:#f5f5f5">
  <th style="border:1px solid #777;width:10%;text-align:center">HSN/SAC</th>
  <th style="border:1px solid #777;width:18%;text-align:center">Taxable Value</th>
  <th style="border:1px solid #777;width:9%;text-align:center">CGST Rate</th>
  <th style="border:1px solid #777;width:14%;text-align:center">CGST Amount</th>
  <th style="border:1px solid #777;width:9%;text-align:center">SGST Rate</th>
  <th style="border:1px solid #777;width:14%;text-align:center">SGST Amount</th>
  <th style="border:1px solid #777;width:14%;text-align:center">Total Tax Amount</th>
</tr>
</thead>
<tbody>
${taxSummaryRows || '<tr><td colspan="7" style="border:1px solid #777;text-align:center">No items</td></tr>'}
<tr style="font-weight:bold;background:#f5f5f5">
  <td style="border:1px solid #777;padding:2px 3px">Total</td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right">${fmtINR(taxableValue)}</td>
  <td style="border:1px solid #777"></td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right">${fmtINR(cgstAmount)}</td>
  <td style="border:1px solid #777"></td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right">${fmtINR(sgstAmount)}</td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right">${fmtINR(totalTax)}</td>
</tr>
</tbody>
</table>
<div style="border:1px solid #777;border-top:none;padding:2px 5px;font-size:7.5px">
  <span style="font-weight:bold">Tax Amount (in words): </span>${numToWords(totalTax)}
</div>
<table style="width:100%;border:1px solid #777;border-top:none">
<tr>
  <td style="width:35%;border-right:1px solid #777;padding:3px 5px;vertical-align:top">
    <div style="font-weight:bold;font-size:8px;border-bottom:1px solid #777;margin-bottom:2px;padding-bottom:1px">Company's Bank Details</div>
    <div style="font-size:7.5px;line-height:1.7">
      <div>A/c Holder's Name: BLUECHIP COMPUTER SYSTEM</div>
      <div>Bank Name: ICICI BANK</div>
      <div>A/c No.: 773205000246</div>
      <div>Branch: DARBAR CHOKDI BRANCH</div>
      <div>IFSC Code: ICIC0007732</div>
    </div>
  </td>
  <td style="width:65%;padding:3px 5px;vertical-align:top">
    <div style="font-weight:bold;font-size:8px;border-bottom:1px solid #777;margin-bottom:2px;padding-bottom:1px">Declaration</div>
    <div style="font-size:7.5px;line-height:1.6">${esc(declarationTerms)}</div>
  </td>
</tr>
</table>
<table style="width:100%;border:1px solid #777;border-top:none">
<tr>
  <td style="width:70%;border-right:1px solid #777;padding:3px 5px;vertical-align:top">
    <div style="font-size:7.5px;color:#555;text-align:center">This is a Computer Generated Invoice</div>
  </td>
  <td style="width:30%;padding:3px 5px;vertical-align:top;text-align:center">
    ${stampImg}
    <div style="font-size:8px;font-weight:bold">For ${esc(asusCompanyName)}</div>
    <div style="height:20px"></div>
    <div style="border-top:1px solid #000;font-size:7.5px;padding-top:2px">Authorised Signatory</div>
  </td>
</tr>
</table>
</div>
</body></html>`;
}

async function generateOrderInvoicePdf(orderId) {
  const oRes = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (oRes.rows.length === 0) throw new Error('Order not found');
  const order = oRes.rows[0];

  const compRes = await query('SELECT * FROM order_components WHERE order_id = $1', [orderId]);
  const components = compRes.rows || [];

  const store = await getStoreData(order.store_id);

  const orderNumber = order.order_number || orderId;
  const fileName = `Invoice_${orderNumber}.pdf`;
  const filePath = path.join(PDF_DIR, fileName);

  const html = buildInvoiceHTML(order, components, store);

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

module.exports = { generateOrderInvoicePdf };