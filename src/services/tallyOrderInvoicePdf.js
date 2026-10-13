const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('./browserService');
const { query } = require('../config/database');

const PDF_DIR = path.join(__dirname, '../../uploads/pdfs/invoice-orders');
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

function isAsusStore(name) {
  return String(name || '').toLowerCase().includes('asus');
}

function isBlueChipStore(name) {
  const storeName = String(name || '').toLowerCase();
  return storeName.includes('blue') && !storeName.includes('asus');
}

// Assembled desktops (Blue Chips) are stored as one order_products row per part,
// all tagged with this series value. On the invoice they are printed under a
// single heading row instead of repeating the label on every line.
const ASSEMBLED_DESKTOP_SERIES = 'Assembled Desktop';
const ASSEMBLED_DESKTOP_HEADING = 'Assembled Desktop (Parts Used)';
const ASSEMBLED_HEADING_KEY = '__assembled_desktop_heading';

function isAssembledPart(prod) {
  return String(prod.series || '').trim().toLowerCase() === ASSEMBLED_DESKTOP_SERIES.toLowerCase();
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

// A serial number only identifies a physical item when it is a real value.
// Placeholders like "N/A" are used for accessories that have no serial, and
// must NOT be treated as an identity - otherwise every accessory row collapses
// into a single invoice line.
function isRealSerial(s) {
  const v = String(s == null ? '' : s).trim().toLowerCase();
  return v !== '' && v !== 'n/a' && v !== 'na' && v !== '-' && v !== 'none' && v !== 'nil' && v !== 'not applicable';
}

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
  const getDefaultStore = async () => {
    const defRes = await query('SELECT * FROM stores WHERE is_default = true AND is_active = true LIMIT 1');
    return defRes.rows[0] || null;
  };

  const getGlobalSettings = async () => {
    try {
      const cRes = await query('SELECT * FROM store_settings LIMIT 1');
      return cRes.rows[0] || {};
    } catch (e) {
      return {};
    }
  };

  let store = null;
  if (storeId) {
    const sRes = await query('SELECT * FROM stores WHERE id = $1 AND is_active = true', [storeId]);
    if (sRes.rows.length > 0) store = sRes.rows[0];
  }
  if (!store) {
    store = await getDefaultStore();
  }

  const [global, defaultStore] = await Promise.all([getGlobalSettings(), getDefaultStore()]);
  if (!store) return global || {};

  // The store record may be incomplete (blank GSTIN / city / pincode / email).
  // Fall back to the default store first, then to the global store_settings row,
  // so the invoice always carries the shop's real branding just like the
  // front-end preview (store > default store > global settings).
  const fallback = { ...global, ...defaultStore };
  return {
    ...store,
    company_name: store.company_name || store.store_name || fallback.company_name || fallback.store_name || '',
    store_name: store.store_name || store.company_name || fallback.store_name || fallback.company_name || '',
    address: store.address || fallback.address || '',
    city: store.city || fallback.city || '',
    state: store.state || fallback.state || 'Gujarat',
    pincode: store.pincode || fallback.pincode || '',
    phone: store.phone || fallback.phone || '',
    email: store.email || fallback.email || '',
    gst_number: store.gst_number || fallback.gst_number || fallback.gst_vat || '',
    gst_vat: store.gst_vat || fallback.gst_vat || fallback.gst_number || '',
    website: store.website || fallback.website || '',
    logo: store.logo || fallback.logo || '',
    terms_conditions: store.terms_conditions || fallback.terms_conditions || '',
  };
}

// Mirrors buildOrderInvoiceItems in ManageOrders.jsx
function buildOrderInvoiceItems(order, components, products) {
  const items = [];
  const productsMap = new Map();
  const accessoryName = order.accessory_type === 'Custom' ? (order.custom_accessory || 'Custom Accessory') : (order.accessory_type || '');
  const orderModel = order.model || '';
  const orderPartNo = order.part_no || '';
  const orderCheckNo = order.check_no || '';
  const orderWarranty = order.warranty || '';
  const orderSerial = order.serial_number || '';
  const svcAmt = parseFloat(order.service_amount) || 0;
  if (svcAmt > 0) {
    items.push({
      name: order.device_type === 'Accessories' ? `Accessories${accessoryName ? ' - ' + accessoryName : ''}` : `${order.device_type || ''}${order.brand ? ' - ' + order.brand + ' ' + orderModel : ''}`,
      description: order.problem_description || '',
      qty: 1,
      price: svcAmt,
      brand: order.brand || '',
      serialNumber: orderSerial,
      modelNo: orderModel,
      partNo: orderPartNo,
      checkNo: orderCheckNo,
      tax: 18,
      hsn: String(order.hsn_code || '').trim(),
      batch: '',
      warranty: orderWarranty,
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
        brand: '',
        serialNumber: '',
        modelNo: '',
        partNo: '',
        checkNo: '',
        tax: 18,
        hsn: '',
        batch: '',
        warranty: comp.warranty || '',
        discount: 0,
      });
    }
  });
  // Product rows (ASUS multi-item sales orders: repeatable device blocks +
  // accessory rows) - each becomes its own invoice line item so the customer
  // sees every device / accessory they bought, one below another.
  // Mirrors buildOrderInvoiceItems in ManageOrders.jsx, including its de-dup:
  // the same physical product can exist twice in order_products (a zero-amount
  // placeholder alongside the real row). Collapse genuine duplicates - same
  // serial (same physical item) or a zero-amount placeholder for the same item.
  (Array.isArray(products) ? products : []).forEach(prod => {
    const prodName = prod.product_name || '';
    const prodAcc = prod.accessory_type || '';
    const prodSeries = (prod.series || '').toString().trim();
    const isAssembled = isAssembledPart(prod);
    // An accessory line belongs to the accessory, not to the device it was sold
    // with, so it must never borrow the device's part / check / serial number.
    const isAccessoryRow = prodName.trim().toLowerCase() === 'accessories' || !!String(prodAcc || '').trim();
    const baseName = prodName.trim()
      ? (prodAcc && prodAcc !== 'Accessories' ? `${prodName} - ${prodAcc}` : prodName)
      : (prodAcc ? `Accessories - ${prodAcc}` : 'Accessories');
    // Assembled parts already sit under the "Assembled Desktop" heading, so the
    // series label is not repeated on each line.
    const lineName = (prodSeries && !isAssembled) ? `${baseName} - ${prodSeries}` : baseName;
    const prodQty = parseInt(prod.quantity, 10) || 1;
    const prodRate = parseFloat(prod.rate) || 0;
    // A stored 0 amount is a real 0 (complimentary line given away free), so
    // only a missing amount falls back to rate * quantity.
    const hasAmt = prod.amount !== undefined && prod.amount !== null && String(prod.amount).trim() !== '';
    const total = hasAmt ? (parseFloat(prod.amount) || 0) : (prodRate * prodQty);
    // Only a real serial number collapses duplicate rows; placeholder serials
    // (N/A) fall back to the name/brand/model key so every row is printed.
    const serial = isRealSerial(prod.serial_number) ? String(prod.serial_number).trim() : '';
    if (!lineName.trim() && total <= 0) return;
    // The brand is part of the line identity so two parts of the same type with
    // different brands (e.g. two SSDs) are never collapsed into one row.
    const key = serial ? `s:${serial}` : `n:${lineName}|${prod.brand || ''}|${prod.product_model || ''}`;
    const entry = {
      name: lineName,
      description: '',
      qty: total > 0 ? prodQty : 1,
      price: prodRate > 0 ? prodRate : (total > 0 ? total : 0),
      total,
      brand: prod.brand || '',
      serialNumber: isAccessoryRow ? (prod.serial_number || '') : (prod.serial_number || orderSerial),
      modelNo: isAccessoryRow ? (prod.product_model || '') : (prod.product_model || orderModel),
      partNo: isAccessoryRow ? (prod.part_no || '') : (prod.part_no || orderPartNo),
      checkNo: isAccessoryRow ? (prod.check_no || '') : (prod.check_no || orderCheckNo),
      tax: 18,
      hsn: String(prod.hsn_code || '').trim(),
      batch: '',
      warranty: prod.warranty || '',
      discount: 0,
      isFree: !!prod.complimentary || (total <= 0 && prodRate > 0),
    };
    if (isAssembled && !productsMap.has(ASSEMBLED_HEADING_KEY)) {
      // Zero-value marker row printed above the first assembled part.
      productsMap.set(ASSEMBLED_HEADING_KEY, {
        isHeading: true,
        name: ASSEMBLED_DESKTOP_HEADING,
        description: '',
        qty: 0,
        price: 0,
        total: 0,
        brand: '',
        serialNumber: '',
        modelNo: '',
        partNo: '',
        checkNo: '',
        tax: 18,
        hsn: '',
        batch: '',
        warranty: '',
        discount: 0,
      });
    }
    const existing = key.startsWith('s:') ? productsMap.get(key) : null;
    if (key.startsWith('s:') && existing) {
      // Same physical item twice - prefer the row that actually carries the value.
      if (entry.total > existing.total) productsMap.set(key, entry);
    } else if (key.startsWith('n:') && productsMap.has(key)) {
      const existingNoKey = productsMap.get(key);
      // Merge only when one entry is a zero-amount placeholder.
      if ((entry.total <= 0) !== (existingNoKey.total <= 0)) {
        productsMap.set(key, entry.total > existingNoKey.total ? entry : existingNoKey);
      } else {
        productsMap.set(`__dup_${productsMap.size}_${Date.now()}`, entry);
      }
    } else {
      productsMap.set(key, entry);
    }
  });
  productsMap.forEach(item => items.push(item));
  if (items.length === 0 && (parseFloat(order.total_amount) || 0) > 0) {
    items.push({
      name: order.device_type === 'Accessories' ? `Accessories${accessoryName ? ' - ' + accessoryName : ''}` : `${order.device_type || ''}${order.brand ? ' - ' + order.brand + ' ' + orderModel : ''}`,
      description: order.problem_description || order.order_note || '',
      qty: 1,
      price: parseFloat(order.total_amount) || 0,
      brand: order.brand || '',
      serialNumber: orderSerial,
      modelNo: orderModel,
      partNo: orderPartNo,
      checkNo: orderCheckNo,
      tax: 18,
      hsn: String(order.hsn_code || '').trim(),
      batch: '',
      warranty: orderWarranty,
      discount: 0,
    });
  }
  return items;
}

function buildInvoiceHTML(order, components, store, products) {
  const taxRate = 18;
  const isAsus = isAsusStore(store.store_name);
  const isBlueChip = isBlueChipStore(store.store_name);

  const items = buildOrderInvoiceItems(order, components, products);

  // Customer amounts are GST-inclusive for every store: back the GST out for the
  // tax columns and never add it on top of the amount again.
  const lineTotals = items.map((i) => {
    if (i && i.isHeading) {
      return { qty: 0, rate: 0, disc: 0, discPct: 0, taxable: 0, cgst: 0, sgst: 0, total: 0, heading: true };
    }
    const qty = parseInt(i.qty) || 1;
    const rate = parseFloat(i.price) || 0;
    // A free line keeps its real rate for display but is discounted by 100% so
    // the taxable value and the invoice totals stay exactly as before.
    const disc = i.isFree ? rate : parseFloat(i.discount || 0);
    const discPct = rate > 0 ? Math.round((disc / rate) * 1000) / 10 : 0;
    const lineIncl = Math.max(0, (rate - disc) * qty);
    const taxable = lineIncl / (1 + taxRate / 100);
    const tax = lineIncl - taxable;
    return { qty, rate, disc, discPct, taxable, cgst: tax / 2, sgst: tax / 2, total: lineIncl };
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
  const remark = order.remark || '';
  // Place of supply / buyer state comes from the order (what the staff entered
  // on the form), falling back to the store state, then Gujarat.
  const custState = String(order.state || '').trim() || state || 'Gujarat';
  const custPhone = order.mobile_number || '';
  const custEmail = order.email || '';
  const custGstin = order.gstin || '';
  const custPin = order.pincode || '';
  const custCity = order.city || '';
  // Out-of-state supply => IGST @18% (single tax) instead of CGST 9% + SGST 9%.
  const interState = String(custState).trim().toLowerCase() !== String(state || 'Gujarat').trim().toLowerCase()

  const terms = order.payment_type || 'Cash';
  const orderNumber = order.order_number || '';
  const invoiceDate = fmtDate(order.order_date || new Date());
  // ASUS store orders carry a persistent sequential invoice number (16, 17, ...).
  const storedInvoiceNumber = order.invoice_number != null && order.invoice_number !== ''
    ? String(order.invoice_number)
    : null;

  const financeDown = parseFloat(order.finance_down_payment || 0) || 0;
  const financeEmi = parseFloat(order.finance_emi || 0) || 0;
  const financeDur = parseInt(order.finance_duration, 10) || 0;
  const isFinance = terms === 'Finance' || order.payment_type === 'Finance';

  // Advance / part-payment details captured on the order form (advance or
  // non-advance booking). Shown in the invoice so the customer can see how
  // much was paid, by which mode, and the balance still due.
  const advancePaid = parseFloat(order.advance_payment) || 0;
  const advanceMode = order.advance_payment_mode || '';
  const balanceDue = Math.max(0, grandTotal - advancePaid);
  // Mirror the order's real payment status instead of always claiming it is
  // settled, so a part-paid / unpaid order cannot print a wrong status.
  const orderPayStatus = String(order.payment_status || '').trim();
  const payStatus = orderPayStatus || (balanceDue <= 0 ? 'Paid Fully' : 'Partially Paid');
  // Settled orders print the status as a green pill so it reads at a glance;
  // anything still owing stays amber so it is not mistaken for a paid sale.
  const isFullyPaid = payStatus.toLowerCase().includes('paid') && !payStatus.toLowerCase().includes('part');
  const payStatusTone = isFullyPaid
    ? { bg: '#e8f5e9', fg: '#1b5e20', border: '#2e7d32' }
    : { bg: '#fff8e1', fg: '#8a6100', border: '#f9a825' };
  // Date the advance was paid: the booking/order date when an advance was
  // received, otherwise today's date.
  const advanceDate = fmtDate(advancePaid > 0 ? (order.advance_paid_date || order.order_date || order.created_at || new Date()) : new Date());

  let asusCompanyName = companyName;
  let asusAddr = addr;
  let asusPhone = phoneNum;
  let asusEmail = emailAddr;
  let asusWebsite = '';
  if (isAsus) {
    asusCompanyName = 'BLUECHIP COMPUTER SYSTEM [ASUS EXCLUSIVE STORE]';
    asusAddr = '05, Harmony complex, Opp. MK High School, Alkapuri, Vadodara-07';
    asusPhone = '9904991114';
    asusEmail = emailAddr || 'aes.bluechip@gmail.com';
    asusWebsite = 'www.bccsgroup.in';
  }

  const invoiceDeclaration = 'We declare that this Invoice shows the actual price of the goods described and that all particulars are true and correct.';
  const asusTermsAndConditions = [
    ['Jurisdiction', 'All disputes shall be subject to the exclusive jurisdiction of Vadodara, Gujarat, subject to applicable law.'],
    ['Return & Exchange', 'As per company policy and applicable law.'],
    ['Delayed Payment', 'Interest at 24% p.a. on overdue payments, subject to applicable law.'],
    ['Warranty', '12-month warranty as per applicable OEM terms. Register at https://www.asus.com/in within 7 days, where applicable.'],
    ['DOA Claims', 'Subject to authorized service centre verification and OEM policy; report within 7 working days.'],
    ['Liability', 'Limited to net invoice value, excluding indirect losses, to the extent permitted by law.'],
    ['Delivery', 'Report physical damage or missing items within 24 hours of delivery.'],
    ['Warranty Disclaimer', 'Manufacturer warranty is governed by OEM terms; statutory rights remain unaffected.'],
    ['Ownership', 'Title remains with the Seller until full payment, subject to applicable law.'],
    ['Force Majeure', 'Neither party is liable for delays caused by events beyond reasonable control.'],
  ];
  const blueChipTermsAndConditions = [
    ['Jurisdiction', 'All disputes shall be subject to the exclusive jurisdiction of Vadodara, Gujarat, subject to applicable law.'],
    ['Return & Exchange', 'As per company policy and applicable law.'],
    ['Delayed Payment', 'Interest at 24% p.a. on overdue payments, subject to applicable law.'],
    ['Warranty', '1-Year warranty as per applicable OEM terms.'],
    ['DOA Claims', 'Subject to authorized service centre verification and OEM policy; report within 7 working days.'],
    ['Liability', 'Limited to net invoice value, excluding indirect losses, to the extent permitted by law.'],
    ['Delivery', 'Report physical damage or missing items within 24 hours of delivery.'],
    ['Warranty Disclaimer', 'Manufacturer warranty is governed by OEM terms; statutory rights remain unaffected.'],
    ['Ownership', 'Title remains with the Seller until full payment, subject to applicable law.'],
    ['Force Majeure', 'Neither party is liable for delays caused by events beyond reasonable control.'],
  ];
  const declarationTerms = isAsus || isBlueChip
    ? invoiceDeclaration
    : store.terms_conditions || invoiceDeclaration;

  // Embed the stamp & sign as an inline data URI so puppeteer renders it without a server.
  const stampPath = path.join(__dirname, '../../public/stamp-sign.jpg');
  let stampImg = '';
  try {
    if (fs.existsSync(stampPath)) {
      const ext = path.extname(stampPath).slice(1).toLowerCase() === 'png' ? 'png' : 'jpeg';
      stampImg = `<img src="data:image/${ext};base64,${fs.readFileSync(stampPath).toString('base64')}" alt="Stamp & Sign" style="max-width:140px;max-height:90px;object-fit:contain;margin:24px auto 8px;" />`;
    }
  } catch (e) {
    stampImg = '';
  }

  let itemSerialNo = 0;
  const itemRows = items.map((item, idx) => {
    const lt = lineTotals[idx] || { qty: 1, taxable: 0, cgst: 0, sgst: 0, total: 0 };
    if (item && item.isHeading) {
      return `<tr>
      <td colspan="${interState ? 10 : 12}" style="border:1px solid #777;padding:3px 5px;background:#f5f5f5;font-weight:bold">${esc(item.name || '')}</td>
    </tr>`;
    }
    itemSerialNo += 1;
    const qty = lt.qty;
    // The printed rate is the item's real stored rate, not the discounted
    // taxable value, so a free line still shows its price next to 100% Disc.
    const rate = lt.rate;
    const itemTaxRate = item.tax || taxRate;
    // HSN/SAC is only printed when one was actually recorded for the line -
    // there is no hardcoded default, so an unentered HSN never shows a code.
    const hsn = String(item.hsn || '').trim() || '-';
    const descLines = [
      `<div style="font-weight:bold">${esc(item.name || 'Service')}</div>`,
      item.brand ? `<div>Brand: ${esc(item.brand)}</div>` : '',
      item.serialNumber ? `<div>Serial No: ${esc(item.serialNumber)}</div>` : '',
      item.modelNo ? `<div>Model No: ${esc(item.modelNo)}</div>` : '',
      item.partNo ? `<div>Part No: ${esc(item.partNo)}</div>` : '',
      item.checkNo ? `<div>Check No: ${esc(item.checkNo)}</div>` : '',
      item.warranty && String(item.warranty).toLowerCase().trim() !== 'no warranty' ? `<div>Warranty: ${String(item.warranty).toUpperCase()} OF HARDWARE WARRANTY</div>` : '',
      item.batch ? `<div>Batch: ${esc(item.batch)}</div>` : '',
      item.description ? `<div style="font-size:7.5px">${esc(item.description)}</div>` : '',
    ].filter(Boolean).join('');
    const itemTaxCells = interState
      ? `<td style="border:1px solid #777;padding:2px 3px;text-align:center;vertical-align:top">${itemTaxRate}%</td>
         <td style="border:1px solid #777;padding:2px 3px;text-align:right;vertical-align:top">${fmtINR(lt.cgst + lt.sgst)}</td>`
      : `<td style="border:1px solid #777;padding:2px 3px;text-align:center;vertical-align:top">${itemTaxRate / 2}%</td>
         <td style="border:1px solid #777;padding:2px 3px;text-align:right;vertical-align:top">${fmtINR(lt.cgst)}</td>
         <td style="border:1px solid #777;padding:2px 3px;text-align:center;vertical-align:top">${itemTaxRate / 2}%</td>
         <td style="border:1px solid #777;padding:2px 3px;text-align:right;vertical-align:top">${fmtINR(lt.sgst)}</td>`;
    return `<tr>
      <td style="border:1px solid #777;padding:2px 3px;text-align:center;vertical-align:top">${itemSerialNo}</td>
      <td style="border:1px solid #777;padding:2px 4px;vertical-align:top">${descLines}</td>
      <td style="border:1px solid #777;padding:2px 3px;text-align:center;vertical-align:top">${esc(hsn)}</td>
      <td style="border:1px solid #777;padding:2px 3px;text-align:center;vertical-align:top">${qty} Qty</td>
      <td style="border:1px solid #777;padding:2px 3px;text-align:right;vertical-align:top">${fmtINR(rate)}</td>
      <td style="border:1px solid #777;padding:2px 3px;text-align:center;vertical-align:top">${lt.discPct > 0 ? lt.discPct + '%' : ''}</td>
      <td style="border:1px solid #777;padding:2px 3px;text-align:right;vertical-align:top">${fmtINR(lt.taxable)}</td>
      ${itemTaxCells}
      <td style="border:1px solid #777;padding:2px 3px;text-align:right;vertical-align:top;font-weight:bold">${fmtINR(lt.total)}</td>
    </tr>`;
  }).join('');

  const taxSummaryRows = items.map((item, idx) => {
    // Heading rows carry no HSN / no tax - they are skipped in the tax summary.
    if (item && item.isHeading) return '';
    const lt = lineTotals[idx] || { taxable: 0, cgst: 0, sgst: 0 };
    const itr = item.tax || taxRate;
    const taxCols = interState
      ? `<td style="border:1px solid #777;text-align:center">${itr}%</td>
         <td style="border:1px solid #777;text-align:right">${fmtINR(lt.cgst + lt.sgst)}</td>`
      : `<td style="border:1px solid #777;text-align:center">${itr / 2}%</td>
         <td style="border:1px solid #777;text-align:right">${fmtINR(lt.cgst)}</td>
         <td style="border:1px solid #777;text-align:center">${itr / 2}%</td>
         <td style="border:1px solid #777;text-align:right">${fmtINR(lt.sgst)}</td>`;
    return `<tr>
      <td style="border:1px solid #777;text-align:center">${esc(String(item.hsn || '').trim() || '-')}</td>
      <td style="border:1px solid #777;text-align:right">${fmtINR(lt.taxable)}</td>
      ${taxCols}
      <td style="border:1px solid #777;text-align:right">${fmtINR(lt.cgst + lt.sgst)}</td>
    </tr>`;
  }).join('');

  const itemHeaderRow = interState
    ? `<tr style="background:#f5f5f5">
  <th style="border:1px solid #777;width:3%;text-align:center">Sl No.</th>
  <th style="border:1px solid #777;width:33%;text-align:center">Description of Goods</th>
  <th style="border:1px solid #777;width:7%;text-align:center">HSN/SAC</th>
  <th style="border:1px solid #777;width:7%;text-align:center">Quantity</th>
  <th style="border:1px solid #777;width:8%;text-align:center">Rate (Excl. Tax)</th>
  <th style="border:1px solid #777;width:5%;text-align:center">Disc %</th>
  <th style="border:1px solid #777;width:9%;text-align:center">Taxable Value</th>
  <th style="border:1px solid #777;width:7%;text-align:center">IGST %</th>
  <th style="border:1px solid #777;width:9%;text-align:center">IGST Amt</th>
  <th style="border:1px solid #777;width:10%;text-align:center">Amount</th>
</tr>`
    : `<tr style="background:#f5f5f5">
  <th style="border:1px solid #777;width:3%;text-align:center">Sl No.</th>
  <th style="border:1px solid #777;width:28%;text-align:center">Description of Goods</th>
  <th style="border:1px solid #777;width:7%;text-align:center">HSN/SAC</th>
  <th style="border:1px solid #777;width:6%;text-align:center">Quantity</th>
  <th style="border:1px solid #777;width:7%;text-align:center">Rate (Excl. Tax)</th>
  <th style="border:1px solid #777;width:5%;text-align:center">Disc %</th>
  <th style="border:1px solid #777;width:8%;text-align:center">Taxable Value</th>
  <th style="border:1px solid #777;width:5%;text-align:center">CGST %</th>
  <th style="border:1px solid #777;width:7%;text-align:center">CGST Amt</th>
  <th style="border:1px solid #777;width:5%;text-align:center">SGST %</th>
  <th style="border:1px solid #777;width:7%;text-align:center">SGST Amt</th>
  <th style="border:1px solid #777;width:9%;text-align:center">Amount</th>
</tr>`;

  const itemSpacerRow = interState
    ? `<tr>
  <td style="border-left:1px solid #777;border-right:1px solid #777;height:35mm"></td>
  <td style="border-left:1px solid #777;border-right:1px solid #777;vertical-align:top;padding:3px 5px"><div style="font-size:7.5px;line-height:1.5">${remark ? 'Remark: ' + esc(remark) : ''}</div></td>
  <td style="border-left:1px solid #777;border-right:1px solid #777"></td>
  <td style="border-left:1px solid #777;border-right:1px solid #777"></td>
  <td style="border-left:1px solid #777;border-right:1px solid #777"></td>
  <td style="border-left:1px solid #777;border-right:1px solid #777"></td>
  <td style="border-left:1px solid #777;border-right:1px solid #777"></td>
  <td style="border-left:1px solid #777;border-right:1px solid #777"></td>
  <td style="border-left:1px solid #777;border-right:1px solid #777"></td>
</tr>`
    : `<tr>
  <td style="border-left:1px solid #777;border-right:1px solid #777;height:35mm"></td>
  <td style="border-left:1px solid #777;border-right:1px solid #777;vertical-align:top;padding:3px 5px"><div style="font-size:7.5px;line-height:1.5">${remark ? 'Remark: ' + esc(remark) : ''}</div></td>
  <td style="border-left:1px solid #777;border-right:1px solid #777"></td>
  <td style="border-left:1px solid #777;border-right:1px solid #777"></td>
  <td style="border-left:1px solid #777;border-right:1px solid #777"></td>
  <td style="border-left:1px solid #777;border-right:1px solid #777"></td>
  <td style="border-left:1px solid #777;border-right:1px solid #777"></td>
  <td style="border-left:1px solid #777;border-right:1px solid #777"></td>
  <td style="border-left:1px solid #777;border-right:1px solid #777"></td>
  <td style="border-left:1px solid #777;border-right:1px solid #777"></td>
  <td style="border-left:1px solid #777;border-right:1px solid #777"></td>
</tr>`;

  const itemTotalRow = interState
    ? `<tr>
  <td colspan="5" style="border:1px solid #777;padding:2px 4px;font-weight:bold">Total</td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right;font-weight:bold">${fmtINR(taxableValue)}</td>
  <td style="border:1px solid #777"></td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right;font-weight:bold">${fmtINR(totalTax)}</td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right;font-weight:bold">&#8377;${fmtINR(grandTotal)}</td>
</tr>`
    : `<tr>
  <td colspan="5" style="border:1px solid #777;padding:2px 4px;font-weight:bold">Total</td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right;font-weight:bold">${fmtINR(taxableValue)}</td>
  <td style="border:1px solid #777"></td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right;font-weight:bold">${fmtINR(cgstAmount)}</td>
  <td style="border:1px solid #777"></td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right;font-weight:bold">${fmtINR(sgstAmount)}</td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right;font-weight:bold">&#8377;${fmtINR(grandTotal)}</td>
</tr>`;

  const taxSummaryHeader = interState
    ? `<tr style="background:#f5f5f5">
  <th style="border:1px solid #777;width:14%;text-align:center">HSN/SAC</th>
  <th style="border:1px solid #777;width:24%;text-align:center">Taxable Value</th>
  <th style="border:1px solid #777;width:14%;text-align:center">IGST Rate</th>
  <th style="border:1px solid #777;width:24%;text-align:center">IGST Amount</th>
  <th style="border:1px solid #777;width:24%;text-align:center">Total Tax Amount</th>
</tr>`
    : `<tr style="background:#f5f5f5">
  <th style="border:1px solid #777;width:10%;text-align:center">HSN/SAC</th>
  <th style="border:1px solid #777;width:18%;text-align:center">Taxable Value</th>
  <th style="border:1px solid #777;width:9%;text-align:center">CGST Rate</th>
  <th style="border:1px solid #777;width:14%;text-align:center">CGST Amount</th>
  <th style="border:1px solid #777;width:9%;text-align:center">SGST Rate</th>
  <th style="border:1px solid #777;width:14%;text-align:center">SGST Amount</th>
  <th style="border:1px solid #777;width:14%;text-align:center">Total Tax Amount</th>
</tr>`;

  const taxSummaryTotalRow = interState
    ? `<tr style="font-weight:bold;background:#f5f5f5">
  <td style="border:1px solid #777;padding:2px 3px">Total</td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right">${fmtINR(taxableValue)}</td>
  <td style="border:1px solid #777"></td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right">${fmtINR(totalTax)}</td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right">${fmtINR(totalTax)}</td>
</tr>`
    : `<tr style="font-weight:bold;background:#f5f5f5">
  <td style="border:1px solid #777;padding:2px 3px">Total</td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right">${fmtINR(taxableValue)}</td>
  <td style="border:1px solid #777"></td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right">${fmtINR(cgstAmount)}</td>
  <td style="border:1px solid #777"></td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right">${fmtINR(sgstAmount)}</td>
  <td style="border:1px solid #777;padding:2px 3px;text-align:right">${fmtINR(totalTax)}</td>
</tr>`;

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
      <td style="width:110px;display:table-cell;vertical-align:middle;text-align:center;padding:4px 6px;border-right:1px solid #777">
        ${logoSrc ? `<img src="${esc(logoSrc)}" style="max-width:100%;max-height:120px;object-fit:contain" />` : ''}
      </td>
      <td style="vertical-align:top;padding-left:8px">
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
      <tr><td style="border-bottom:1px solid #777;border-right:1px solid #777;padding:2px 4px" class="lbl">Invoice No.</td><td style="border-bottom:1px solid #777;padding:2px 4px">${esc(storedInvoiceNumber || (terms === 'Finance' ? 'FIN-' : 'INV-') + orderNumber)}</td></tr>
      <tr><td style="border-bottom:1px solid #777;border-right:1px solid #777;padding:2px 4px" class="lbl">Dated</td><td style="border-bottom:1px solid #777;padding:2px 4px">${invoiceDate}</td></tr>
      <tr><td style="border-bottom:1px solid #777;border-right:1px solid #777;padding:2px 4px" class="lbl">Mode/Terms of Payment</td><td style="border-bottom:1px solid #777;padding:2px 4px">${esc(terms)}${isFinance ? '<br/><span style="font-size:6.5px">Finance: Down ' + fmtINR(financeDown) + ' + EMI ' + fmtINR(financeEmi) + '/mo for ' + financeDur + ' months</span>' : ''}</td></tr>
      <tr><td style="border-bottom:1px solid #777;border-right:1px solid #777;padding:2px 4px" class="lbl">Reference No. &amp; Date</td><td style="border-bottom:1px solid #777;padding:2px 4px">${esc(orderNumber)} / ${invoiceDate}</td></tr>
      <tr><td style="border-bottom:1px solid #777;border-right:1px solid #777;padding:2px 4px" class="lbl">Buyer's Order No.</td><td style="border-bottom:1px solid #777;padding:2px 4px">${esc(orderNumber)}</td></tr>
      <tr><td style="border-right:1px solid #777;padding:2px 4px" class="lbl">Destination</td><td style="padding:2px 4px">${esc(custState)}${custPin ? ' - ' + esc(custPin) : ''}</td></tr>
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
      ${(custCity || custPin) ? `<div>${[esc(custCity), esc(custPin)].filter(Boolean).join(' - ')}</div>` : ''}
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
      ${(custCity || custPin) ? `<div>${[esc(custCity), esc(custPin)].filter(Boolean).join(' - ')}</div>` : ''}
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
${itemHeaderRow}
</thead>
<tbody>
${itemRows || `<tr><td colspan="${interState ? 9 : 11}" style="border:1px solid #777;padding:2px 3px;text-align:center">No items</td></tr>`}
${itemSpacerRow}
${itemTotalRow}
</tbody>
</table>
<div style="border:1px solid #777;border-top:none;padding:3px 5px;display:flex;justify-content:space-between">
  <div><span style="font-weight:bold">Amount Chargeable (in words): </span>${numToWords(grandTotal)}</div>
  <div style="font-style:italic;font-size:7.5px">E. &amp; O.E</div>
</div>
<table style="width:100%;border:1px solid #777;border-top:none">
<thead>
${taxSummaryHeader}
</thead>
<tbody>
${taxSummaryRows || `<tr><td colspan="${interState ? 5 : 7}" style="border:1px solid #777;text-align:center">No items</td></tr>`}
${taxSummaryTotalRow}
</tbody>
</table>
<div style="border:1px solid #777;border-top:none;padding:2px 5px;font-size:7.5px">
  <span style="font-weight:bold">Tax Amount (in words): </span>${numToWords(totalTax)}
</div>
<table style="width:100%;border:1px solid #777;border-top:none">
<thead>
<tr style="background:#f5f5f5">
  <th style="border:1px solid #777;font-size:8px;text-align:left;padding:2px 4px" colspan="4">Payment Details</th>
</tr>
</thead>
<tbody>
<tr style="font-size:8px">
  <td style="border:1px solid #777;padding:2px 4px"><span class="lbl">Total Amount:</span> &#8377;${fmtINR(grandTotal)}</td>
  <td style="border:1px solid #777;padding:2px 4px"><span class="lbl">Advance Paid:</span> &#8377;${fmtINR(advancePaid)}</td>
  <td style="border:1px solid #777;padding:2px 4px"><span class="lbl">Payment Mode:</span> ${esc(advanceMode || terms || '-')}</td>
  <td style="border:1px solid #777;padding:2px 4px"><span class="lbl">Balance Amount:</span> &#8377;${fmtINR(balanceDue)}</td>
</tr>
<tr style="font-size:8px">
  <td style="border:1px solid #777;padding:2px 4px" colspan="2"><span class="lbl">Advance Payment Date:</span> ${advanceDate || '-'}</td>
  <td style="border:1px solid #777;padding:2px 4px" colspan="2"><span class="lbl">Payment Status:</span> <span style="display:inline-block;padding:1px 10px;border-radius:11px;font-weight:bold;font-size:9px;letter-spacing:0.3px;background:${payStatusTone.bg};color:${payStatusTone.fg};border:1px solid ${payStatusTone.border}">${esc(payStatus)}</span></td>
</tr>
</tbody>
</table>
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
    <div style="font-size:7.5px;line-height:1.6;white-space:pre-line">${esc(declarationTerms)}</div>
  </td>
</tr>
</table>
<table style="width:100%;border:1px solid #777;border-top:none">
<tr>
  <td style="width:70%;border-right:1px solid #777;padding:4px 6px;vertical-align:top">
    <div style="font-weight:bold;font-size:8px;margin-bottom:3px">${isAsus || isBlueChip ? 'TERMS &amp; CONDITIONS' : 'BLUE CHIP PRODUCT INSPECTION &amp; CUSTOMER ACKNOWLEDGEMENT: -'}</div>
    <div style="font-size:7.5px;line-height:1.6">
      ${isAsus
        ? asusTermsAndConditions.map(([label, text], index) => `<div><b>${index + 1}. ${esc(label)}:</b> ${esc(text)}</div>`).join('')
        : isBlueChip
          ? blueChipTermsAndConditions.map(([label, text], index) => `<div><b>${index + 1}. ${esc(label)}:</b> ${esc(text)}</div>`).join('')
          : `
      <div><b>1. Product Opening &amp; Demonstration</b><br/>The product has been opened and demonstrated in the presence of the customer.</div>
      <div><b>2. Product Inspection</b><br/>The customer has thoroughly inspected and checked the product. No issues or defects were found at the time of inspection.</div>
      <div><b>3. Extended Warranty Information</b><br/>The Blue Chip team has explained the available Extended Warranty options and applicable terms &amp; conditions to the customer.</div>
      <div><b>4. Customer Support</b><br/>For any assistance or support, the customer may contact the Blue Chip Computer Store during working hours at +91 99049 91819.</div>
      <div><b>5. Advance Booking Amount Policy</b><br/>The advance booking amount is non-refundable. However, if the customer chooses not to proceed with the booked product, the advance amount may be redeemed against any complimentary product of equal value available at the Blue Chip Computer Store.</div>
      <div><b>6. DOA (DEAD ON ARRIVAL) POLICY</b><br/>In case of a DOA (Dead on Arrival) claim, the product is eligible for DOA consideration only within 7 working days from the date of invoice, subject to the applicable DOA Policy.</div>
      <div>The system must first be submitted to an authorized Service Centre for inspection and verification. The final decision regarding DOA eligibility and replacement will be made by the authorized Service Centre based on their inspection and approval.</div>
      <div>The store will not be responsible for the approval or rejection of any DOA replacement. All DOA claims and replacements will be governed strictly by the applicable policy and its terms &amp; conditions.</div>
      `}
    </div>
  </td>
  <td style="width:30%;padding:3px 5px;vertical-align:top;text-align:center">
    ${stampImg ? `<div style="text-align:center;margin-bottom:4px">${stampImg}</div>` : ''}
    <div style="font-size:8px;font-weight:bold;margin-top:10px">For ${esc(asusCompanyName)}</div>
    <div style="height:60px"></div>
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

  // If this order was converted from an advance booking, use the original
  // booking date as the date the advance was paid.
  try {
    const bookRes = await query(
      `SELECT order_date FROM orders
        WHERE booking_type = 'advanced' AND linked_order_id = $1
        ORDER BY id LIMIT 1`,
      [orderId]
    );
    if (bookRes.rows.length > 0 && bookRes.rows[0].order_date) {
      order.advance_paid_date = bookRes.rows[0].order_date;
    }
  } catch (e) { /* ignore — fall back to order date */ }

  const compRes = await query('SELECT * FROM order_components WHERE order_id = $1', [orderId]);
  const components = compRes.rows || [];

  const prodRes = await query(
    `SELECT product_name, product_model, serial_number, warranty, quantity, rate, amount, accessory_type, part_no, check_no, series, hsn_code, complimentary
     FROM order_products WHERE order_id = $1 ORDER BY id`,
    [orderId]
  );
  const products = prodRes.rows || [];

  const store = await getStoreData(order.store_id);

  const orderNumber = order.order_number || orderId;
  const fileName = `Invoice_${orderNumber}.pdf`;
  const filePath = path.join(PDF_DIR, fileName);

  const html = buildInvoiceHTML(order, components, store, products);

  const browser = await launchBrowser();
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