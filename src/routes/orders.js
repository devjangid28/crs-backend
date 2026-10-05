const express = require('express');
const router = express.Router();
const { query, getConnection } = require('../config/database');
const { notifyOrderCreated, notifyBookingCreated, sendOrderInvoiceTemplate, getConversationIdFromPhone } = require('../services/whatsappService');
const { generateOrderInvoicePdf } = require('../services/tallyOrderInvoicePdf');
const { createPdfMessage, updateMessageStatusById } = require('../services/messagingService');

async function getStoreInfo(storeId) {
  if (storeId) {
    const sRes = await query('SELECT * FROM stores WHERE id = $1 AND is_active = true', [storeId]);
    if (sRes.rows.length > 0) return sRes.rows[0];
  }
  const dRes = await query('SELECT * FROM stores WHERE is_default = true AND is_active = true LIMIT 1');
  if (dRes.rows.length > 0) return dRes.rows[0];
  const fRes = await query('SELECT * FROM store_settings LIMIT 1');
  return fRes.rows[0] || {};
}

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

// Resolve a field that may arrive in either camelCase or snake_case.
function srcVal(src, camelKey, snakeKey) {
  if (src[camelKey] !== undefined && src[camelKey] !== null) return src[camelKey];
  if (src[snakeKey] !== undefined && src[snakeKey] !== null) return src[snakeKey];
  return undefined;
}

// Determine payment status from the advance (total received so far) and the
// remaining balance. A small tolerance handles floating-point rounding from
// tax math (e.g. remaining = 0.009999...) so a fully settled order shows
// 'Paid' instead of lingering on 'Partially Paid', and a zero-advance order
// (walk-in full payment recorded as total received) also maps to 'Paid'.
function computePaymentStatus(advance, remainingBalance) {
  if (advance <= 0) return 'Unpaid';
  if (remainingBalance <= 0.01) return 'Paid';
  return 'Partially Paid';
}

// Convert an ASUS "device block" (repeatable Device Type entries) into the same
// shape used by order_products so devices + accessories appear one below another
// in the invoice Description of Goods.
function deviceToProduct(d) {
  const deviceType = String(srcVal(d, 'deviceType', 'device_type') || '').trim();
  const amount = parseFloat(srcVal(d, 'deviceAmount', 'device_amount')) || 0;
  const isAccessory = deviceType.toLowerCase() === 'accessories';
  const accessoryType = isAccessory
    ? (srcVal(d, 'accessoryType', 'accessory_type') && srcVal(d, 'accessoryType', 'accessory_type') === 'Custom'
        ? (srcVal(d, 'customAccessory', 'custom_accessory') || 'Custom')
        : (srcVal(d, 'accessoryType', 'accessory_type') || ''))
    : undefined;
  const specs = srcVal(d, 'specifications', 'specifications');
  // Assembled-desktop parts arrive with their own qty and rate; plain device
  // blocks do not, so they keep qty 1 with the amount as the rate.
  const quantity = Math.max(1, parseInt(srcVal(d, 'quantity', 'quantity'), 10) || 1);
  const givenRate = parseFloat(srcVal(d, 'rate', 'rate'));
  const rate = Number.isFinite(givenRate) && givenRate > 0
    ? givenRate
    : (quantity > 1 ? amount / quantity : amount);
  return {
    productName: (isAccessory ? 'Accessories' : deviceType) || 'Device',
    // A Blue Chips assembled-desktop part records its own brand next to its
    // specification, so it is stored per product line and printed on the
    // invoice with the rest of the part detail.
    brand: srcVal(d, 'brand', 'brand') || undefined,
    productModel: srcVal(d, 'model', 'productModel') || srcVal(d, 'product_model', 'productModel') || undefined,
    serialNumber: srcVal(d, 'serialNumber', 'serial_number') || undefined,
    warranty: srcVal(d, 'warranty', 'warranty') || undefined,
    partNo: srcVal(d, 'partNo', 'part_no') || undefined,
    checkNo: srcVal(d, 'checkNo', 'check_no') || undefined,
    series: srcVal(d, 'series', 'series') || undefined,
    accessoryType,
    specifications: specs && typeof specs === 'object' && !Array.isArray(specs) ? specs : undefined,
    quantity,
    rate,
    amount,
  };
}

// Combine repeatable device blocks + accessory product rows into one list.
function mergeOrderProducts(devices, products) {
  const deviceRows = Array.isArray(devices)
    ? devices.filter(d => {
        if (!d) return false
        const dtype = (srcVal(d, 'deviceType', 'device_type') || '').trim()
        if (!dtype) return false
        const amount = parseFloat(srcVal(d, 'deviceAmount', 'device_amount')) || 0
        if (amount > 0) return true
        if (dtype.toLowerCase() === 'accessories') return true
        // Assembled-desktop parts are recorded as-is, so a ticked part is never
        // silently dropped just because its rate has not been filled in yet.
        return String(srcVal(d, 'series', 'series') || '').trim().toLowerCase() === 'assembled desktop'
      }).map(deviceToProduct)
    : [];
  const prodRows = Array.isArray(products) ? products.filter(p => p && (p.productName || p.product_name)) : [];

  // De-duplicate: an "Accessories" device block with zero amount is just a
  // category placeholder. When a real product row for the same accessory (same
  // serial number or same accessory type) exists, drop the placeholder so the
  // invoice / order never shows the same product twice.
  if (prodRows.length > 0) {
    return deviceRows
      .filter(d => {
        if (String(srcVal(d, 'productName', 'product_name') || '').trim().toLowerCase() !== 'accessories') return true
        if ((parseFloat(srcVal(d, 'amount', 'amount')) || 0) > 0) return true
        const dSerial = String(srcVal(d, 'serialNumber', 'serial_number') || '').trim()
        const dAcc = String(srcVal(d, 'accessoryType', 'accessory_type') || '').trim().toLowerCase()
        return !prodRows.some(p => {
          const pSerial = String(srcVal(p, 'serialNumber', 'serial_number') || '').trim()
          const pAcc = String(srcVal(p, 'accessoryType', 'accessory_type') || '').trim().toLowerCase()
          if (dSerial && dSerial === pSerial) return true
          if (dAcc && dAcc === pAcc) return true
          return false
        })
      })
      .concat(prodRows);
  }
  return deviceRows.concat(prodRows);
}

// Compute the summed amount of a merged order-products list.
function sumOrderProducts(products) {
  return (Array.isArray(products) ? products : []).reduce((sum, p) => {
    const qty = parseInt(srcVal(p, 'quantity', 'quantity'), 10) || 1;
    const rate = parseFloat(srcVal(p, 'rate', 'rate')) || 0;
    const lineAmt = parseFloat(srcVal(p, 'amount', 'amount')) || (qty * rate);
    return sum + lineAmt;
  }, 0);
}

// Generate order number: ORD-YYYY-MMM-NNNN
async function generateOrderNumber(client) {
  const today = new Date();
  const y = today.getFullYear();
  const month = MONTHS[today.getMonth()];
  const prefix = `ORD-${y}-${month}-`;

  const result = await client.query(
    `SELECT order_number FROM orders WHERE order_number LIKE $1 ORDER BY id DESC LIMIT 1`,
    [`${prefix}%`]
  );

  let nextNum = 1;
  if (result.rows.length > 0) {
    const last = result.rows[0].order_number;
    const parts = last.split('-');
    const lastNum = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastNum)) nextNum = lastNum + 1;
  }

  return `${prefix}${String(nextNum).padStart(4, '0')}`;
}

// GET /api/orders - Get all orders with search & filter
router.get('/', async (req, res, next) => {
  try {
    const { search, paymentStatus, deviceType, date, store_id, page = 1, limit = 50, booking_type, booking_status } = req.query;
    let whereClause = 'WHERE o.is_active = true';
    const params = [];

    if (store_id) {
      whereClause += ` AND o.store_id = ?`;
      params.push(parseInt(store_id));
    }

    if (booking_type) {
      whereClause += ` AND o.booking_type = ?`;
      params.push(booking_type);
    } else {
      whereClause += ` AND (o.booking_type IS NULL OR o.booking_type <> 'advanced')`;
    }

    if (booking_status) {
      whereClause += ` AND o.booking_status = ?`;
      params.push(booking_status);
    }

    if (search) {
      whereClause += ` AND (o.customer_name ILIKE ? OR o.mobile_number ILIKE ? OR o.order_number ILIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s);
    }

    if (paymentStatus) {
      whereClause += ` AND o.payment_status = ?`;
      params.push(paymentStatus);
    }

    if (deviceType) {
      whereClause += ` AND o.device_type = ?`;
      params.push(deviceType);
    }

    if (date) {
      whereClause += ` AND o.order_date = ?`;
      params.push(date);
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const dataSql = `SELECT o.*, COALESCE(json_agg(json_build_object(
      'id', oc.id, 'component_name', oc.component_name,
      'description', oc.description, 'warranty', oc.warranty,
      'quantity', oc.quantity, 'price', oc.price, 'amount', oc.amount,
      'remarks', oc.remarks, 'status', oc.status
    )) FILTER (WHERE oc.id IS NOT NULL), '[]'::json) AS components,
    COALESCE((
      SELECT json_agg(json_build_object(
        'id', op.id, 'product_name', op.product_name,
        'product_model', op.product_model, 'serial_number', op.serial_number,
        'warranty', op.warranty, 'quantity', op.quantity,
        'rate', op.rate, 'amount', op.amount,
        'accessory_type', op.accessory_type, 'part_no', op.part_no, 'check_no', op.check_no, 'series', op.series, 'brand', op.brand, 'specifications', op.specifications
      ))
      FROM order_products op WHERE op.order_id = o.id
    ), '[]'::json) AS products
    FROM orders o
    LEFT JOIN order_components oc ON oc.order_id = o.id
    ${whereClause}
    GROUP BY o.id
    ORDER BY o.created_at DESC LIMIT ? OFFSET ?`;
    const countSql = `SELECT COUNT(*) as total FROM orders o ${whereClause}`;
    const dataParams = [...params, parseInt(limit), offset];

    const [ordersResult, countResult] = await Promise.all([
      query(dataSql, dataParams),
      query(countSql, params),
    ]);
    const total = parseInt(countResult.rows[0]?.total) || 0;

    res.json({
      success: true,
      data: ordersResult.rows,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/orders/next-number - Preview next order number
router.get('/next-number', async (req, res, next) => {
  try {
    const client = await getConnection();
    try {
      const orderNumber = await generateOrderNumber(client);
      res.json({ success: true, data: { orderNumber } });
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/orders/customer-lookup - Partial phone/name lookup of customers who
// shopped at a specific store (used by the ASUS order form to show a live list
// of matching customers as the user types a few digits). Scoped to a store so a
// store always sees only its own customers.
router.get('/customer-lookup', async (req, res, next) => {
  try {
    const { store_id, phone, name, limit = 8 } = req.query;
    const digits = String(phone || '').replace(/[^\d]/g, '');
    const cleanName = String(name || '').trim();
    const max = Math.min(parseInt(limit, 10) || 8, 20);

    if (!store_id) {
      return res.status(400).json({ success: false, message: 'store_id is required' });
    }
    if (digits.length < 2 && !cleanName) {
      return res.json({ success: true, data: [] });
    }

    const storeId = parseInt(store_id, 10);
    const pattern = `%${digits}%`;
    const namePattern = cleanName ? `%${cleanName}%` : null;
    const params = [storeId];

    let where = `o.is_active = true AND o.store_id = ?`;
    if (digits.length >= 2) {
      where += ` AND (o.mobile_number ILIKE ? OR o.customer_name ILIKE ?)`;
      params.push(pattern, pattern);
    } else if (namePattern) {
      where += ` AND o.customer_name ILIKE ?`;
      params.push(namePattern);
    }

    const ordersSql = `
      SELECT
        o.customer_name AS name,
        o.mobile_number AS mobile,
        o.email,
        o.address,
        o.gstin,
        COUNT(*)::int AS order_count,
        MAX(o.order_date)::text AS last_order_date
      FROM orders o
      WHERE ${where}
        AND (o.booking_type IS NULL OR o.booking_type <> 'advanced')
      GROUP BY o.customer_name, o.mobile_number, o.email, o.address, o.gstin
      ORDER BY last_order_date DESC NULLS LAST
      LIMIT ?`;
    params.push(max);

    // Pending advanced bookings for the same store. These are attached to the
    // matched customer (or added on their own) so the order form can show the
    // "Advanced Paid" badge + booking details for a number that has a booking.
    const advWhere = `o.is_active = true AND o.store_id = ?`
      + ` AND o.booking_type = 'advanced' AND o.booking_status = 'pending'`;
    let advWhereMatch = advWhere;
    if (digits.length >= 2) {
      advWhereMatch = `${advWhere} AND (o.mobile_number ILIKE ? OR o.customer_name ILIKE ?)`;
    } else if (namePattern) {
      advWhereMatch = `${advWhere} AND o.customer_name ILIKE ?`;
    }
    const advSql = `
      SELECT
        o.customer_name AS name,
        o.mobile_number AS mobile,
        o.email,
        o.address,
        o.gstin,
        0 AS order_count,
        NULL::text AS last_order_date,
        json_build_object(
          'booking_id', o.id,
          'booking_number', o.order_number,
          'booking_date', to_char(o.order_date, 'YYYY-MM-DD'),
          'advance_payment', o.advance_payment,
          'advance_payment_mode', o.advance_payment_mode,
          'total_amount', o.total_amount,
          'remaining_balance', o.remaining_balance,
          'payment_status', o.payment_status,
          'store_id', o.store_id,
          'devices', COALESCE((
            SELECT json_agg(json_build_object(
              'product_name', op.product_name,
              'product_model', op.product_model,
              'serial_number', op.serial_number,
              'warranty', op.warranty,
              'quantity', op.quantity,
              'rate', op.rate,
              'amount', op.amount,
              'accessory_type', op.accessory_type,
              'part_no', op.part_no,
              'check_no', op.check_no,
              'series', op.series,
              'brand', op.brand,
              'specifications', op.specifications
            ))
            FROM order_products op WHERE op.order_id = o.id
          ), '[]'::json)
        ) AS advance_booking
      FROM orders o
      WHERE ${advWhereMatch}
      ORDER BY o.created_at DESC
      LIMIT ?`;

    const [ordersRes, customersRes, advanceRes] = await Promise.all([
      query(ordersSql, params),
      query(
        `SELECT name, phone AS mobile, phone2, email, address, gstin,
                0 AS order_count, NULL::text AS last_order_date
         FROM customers c
         WHERE c.store_id = ?
           AND (c.phone ILIKE ? OR c.phone2 ILIKE ? OR c.name ILIKE ?)
         LIMIT ?`,
        [storeId, pattern, pattern, pattern, max]
      ),
      query(
        advSql,
        (() => {
          const a = [storeId];
          if (digits.length >= 2) {
            a.push(pattern, pattern);
          } else if (namePattern) {
            a.push(namePattern);
          }
          a.push(max);
          return a;
        })()
      ),
    ]);

    // Merge orders + registered customers + pending advance bookings and
    // de-duplicate by the last 10 digits of the mobile number so the number
    // shown is always a clean 10-digit line.
    const byPhone = new Map();
    const norm = (m) => String(m || '').replace(/[^\d]/g, '').replace(/^0+/, '').slice(-10);
    const addRow = (row) => {
      const key = norm(row.mobile);
      if (!key) return;
      if (!byPhone.has(key)) byPhone.set(key, { ...row, mobile: key, has_pending_advance: false, advance_booking: null });
    };
    ordersRes.rows.forEach(addRow);
    customersRes.rows.forEach(addRow);
    advanceRes.rows.forEach(row => {
      const key = norm(row.mobile);
      if (!key) return;
      if (byPhone.has(key)) {
        byPhone.get(key).has_pending_advance = true;
        byPhone.get(key).advance_booking = row.advance_booking;
      } else {
        byPhone.set(key, { ...row, mobile: key, has_pending_advance: true, advance_booking: row.advance_booking });
      }
    });

    res.json({ success: true, data: Array.from(byPhone.values()).slice(0, max) });
  } catch (err) {
    next(err);
  }
});

// GET /api/orders/stats - Payment status counts + advance payment summary
// across ALL orders (not just the current page).
router.get('/stats', async (req, res, next) => {
  try {
    const { store_id } = req.query;
    let whereClause = 'WHERE o.is_active = true AND (o.booking_type IS NULL OR o.booking_type <> \'advanced\')';
    let advWhereClause = 'WHERE o.is_active = true';
    const params = [];
    if (store_id) {
      whereClause += ' AND o.store_id = ?';
      advWhereClause += ' AND o.store_id = ?';
      params.push(parseInt(store_id));
    }

    const aggRes = await query(
      `SELECT
         COUNT(*) FILTER (WHERE o.payment_status = 'Paid') AS paid,
         COUNT(*) FILTER (WHERE o.payment_status = 'Partially Paid') AS partial,
         COUNT(*) FILTER (WHERE o.payment_status = 'Unpaid') AS unpaid,
         COUNT(*) AS total,
         COALESCE(SUM(o.advance_payment), 0) AS total_advance,
         COALESCE(SUM(o.remaining_balance), 0) AS total_remaining,
         COALESCE(SUM(o.total_amount), 0) AS total_revenue
       FROM orders o ${whereClause}`,
      params
    );
    const row = aggRes.rows[0] || {};

    const advRes = await query(
      `SELECT o.id, o.order_number, o.customer_name, o.mobile_number,
              o.total_amount, o.advance_payment, o.remaining_balance,
              o.payment_status, o.payment_type, o.order_date, o.created_at
       FROM orders o ${advWhereClause} AND o.advance_payment > 0
       ORDER BY o.created_at DESC LIMIT 50`,
      params
    );

    res.json({
      success: true,
      data: {
        paid: parseInt(row.paid) || 0,
        partial: parseInt(row.partial) || 0,
        unpaid: parseInt(row.unpaid) || 0,
        total: parseInt(row.total) || 0,
        totalAdvance: parseFloat(row.total_advance) || 0,
        totalRemaining: parseFloat(row.total_remaining) || 0,
        totalRevenue: parseFloat(row.total_revenue) || 0,
        advanceOrders: advRes.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/orders/:id - Get single order with components
router.get('/:id', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT o.*, COALESCE(json_agg(json_build_object(
        'id', oc.id, 'component_name', oc.component_name,
        'description', oc.description, 'warranty', oc.warranty,
        'quantity', oc.quantity, 'price', oc.price, 'amount', oc.amount,
        'remarks', oc.remarks, 'status', oc.status
      )) FILTER (WHERE oc.id IS NOT NULL), '[]'::json) AS components,
      COALESCE((
        SELECT json_agg(json_build_object(
          'id', op.id, 'product_name', op.product_name,
          'product_model', op.product_model, 'serial_number', op.serial_number,
          'warranty', op.warranty, 'quantity', op.quantity,
          'rate', op.rate, 'amount', op.amount,
          'accessory_type', op.accessory_type, 'part_no', op.part_no, 'check_no', op.check_no, 'series', op.series, 'brand', op.brand, 'specifications', op.specifications
        ))
        FROM order_products op WHERE op.order_id = o.id
      ), '[]'::json) AS products
      FROM orders o
      LEFT JOIN order_components oc ON oc.order_id = o.id
      WHERE o.id = ?
      GROUP BY o.id`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/orders - Create order
router.post('/', async (req, res, next) => {
  const client = await getConnection();
  try {
    await client.query('BEGIN');

    const orderNumber = await generateOrderNumber(client);

    const {
      customerName, mobileNumber, email, address, orderDate, deviceType,
      desktopType, brand, model, serialNumber, problemDescription, orderNote,
      serviceAmount = 0, partsAmount = 0, additionalCharges = 0,
      discount = 0, advancePayment = 0, advancePaymentMode,
      paymentType = 'Cash',
      deliveryDate, createdBy, components = [], storeId, specifications,
      warranty, accessoryType, customAccessory, partNo, checkNo, remark,
      gstin, financeDownPayment, financeEmi, financeDuration, products = [], devices = [],
      bookingType
    } = req.body;

    const isBooking = bookingType === 'advanced';
    // An advanced booking has no address field; orders.address is NOT NULL.
    const addressVal = isBooking ? (String(address || '').trim() || 'Advanced Booking') : address;

    // Payment Mode / Advance Payment Mode are free text on the order form (the
    // staff can pick from the dropdown or type their own), so they are trimmed
    // here and capped to the width of their column. payment_type is NOT NULL,
    // so an empty box falls back to Cash rather than failing the insert.
    const paymentTypeVal = String(paymentType || '').trim().slice(0, 50) || 'Cash';
    const advancePaymentModeVal = String(advancePaymentMode || '').trim().slice(0, 100) || null;

    const serviceAmt = parseFloat(serviceAmount) || 0;
    const partsAmt = parseFloat(partsAmount) || 0;
    const additional = parseFloat(additionalCharges) || 0;
    const disc = parseFloat(discount) || 0;

    // ASUS store: the entered Customer Amount is GST-inclusive. GST is
    // recorded for reference but is NOT added on top of the amount.
    // Non-ASUS stores keep the existing GST-inclusive calculation.
    const store = await getStoreInfo(storeId || null);
    const isAsusStore = String(store?.store_name || '').toLowerCase().includes('asus');

    // ASUS store: assign the next available sequential invoice number
    // (16, 17, 18, ...). It is always the smallest number not used by any
    // existing order, so deleting an order frees its number and the next new
    // order reuses it (no gaps). Backed by a persistent DB query + advisory
    // lock + unique index so numbers never duplicate and survive restarts.
    let invoiceNumber = null;
    if (isAsusStore && !isBooking) {
      await client.query(`SELECT pg_advisory_xact_lock($1)`, [8675309]);
      const usedRes = await client.query(
        `SELECT invoice_number FROM orders WHERE invoice_number IS NOT NULL ORDER BY invoice_number`
      );
      const used = new Set(usedRes.rows.map(r => r.invoice_number));
      let n = 16;
      while (used.has(n)) n++;
      invoiceNumber = n;
    }

    // Calculate component totals
    const componentsTotal = Array.isArray(components) ? components.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0) : 0;
    // Repeatable ASUS device blocks + accessory rows all live in order_products.
    const mergedProducts = mergeOrderProducts(devices, products);
    const productsTotal = sumOrderProducts(mergedProducts);
    const subtotal = serviceAmt + componentsTotal + productsTotal;
    const gstRate = 0.18;
    // Customer amounts are GST-inclusive: back the GST out and never add it on top.
    const gstAmount = subtotal - (subtotal / (1 + gstRate));
    const grandTotal = subtotal - disc;

    const advance = parseFloat(advancePayment) || 0;
    const remainingBalance = grandTotal - advance;

    // Business rule: creating a regular order means the payment has been
    // received at the counter, so the order is marked Paid. Only advanced
    // bookings (advance paid now, balance settled on delivery) can be
    // Unpaid / Partially Paid.
    const paymentStatus = isBooking
      ? computePaymentStatus(advance, remainingBalance)
      : 'Paid';

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    // Format today in LOCAL (server) timezone — toISOString() would give the
    // UTC date, which can be the previous calendar day.
    const todayLocal = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    const orderDateVal = orderDate || todayLocal;

    const specsJson = specifications && Array.isArray(specifications) && specifications.length > 0
      ? JSON.stringify(specifications)
      : null;

    const insertResult = await client.query(
      `INSERT INTO orders (
        order_number, customer_name, mobile_number, email, address, order_date,
        device_type, desktop_type, brand, model, serial_number,
        problem_description, order_note, delivery_date, service_amount, parts_amount,
        additional_charges, discount, total_amount, advance_payment,
        advance_payment_mode, remaining_balance, payment_status, payment_type, created_by,
        store_id, subtotal, gst_amount, grand_total, specifications, warranty,
        accessory_type, custom_accessory, part_no, check_no, remark,
        finance_down_payment, finance_emi, finance_duration, gstin, created_at, updated_at, invoice_number,
        booking_type, booking_status, linked_order_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46)
      RETURNING id`,
      [
        orderNumber, customerName, mobileNumber, email || null, addressVal, orderDateVal,
        isBooking ? (deviceType || 'Advanced Booking') : deviceType, desktopType || null, brand || null, model || null, serialNumber || null,
        problemDescription || null, orderNote || null, deliveryDate || null,
        serviceAmt, partsAmt, additional, disc, grandTotal,
        advance, advancePaymentModeVal, remainingBalance, paymentStatus, paymentTypeVal, createdBy || null,
        storeId || null, subtotal, gstAmount, grandTotal, specsJson, warranty || null,
        accessoryType || null, customAccessory || null, partNo || null, checkNo || null, remark || null,
        parseFloat(financeDownPayment) || null, parseFloat(financeEmi) || null,
        parseInt(financeDuration, 10) || null, gstin || null, now, now, invoiceNumber,
        isBooking ? 'advanced' : null, isBooking ? 'pending' : null, null
      ]
    );

    const orderId = insertResult.rows[0].id;

    // Insert components if provided
    if (Array.isArray(components) && components.length > 0) {
      for (const comp of components) {
        await client.query(
          `INSERT INTO order_components (order_id, component_name, description, warranty, quantity, price, amount, remarks, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            orderId, comp.componentName,
            comp.description || null, comp.warranty || null,
            comp.quantity || 1, parseFloat(comp.price) || 0,
            parseFloat(comp.amount) || (parseFloat(comp.price) || 0) * (parseInt(comp.quantity, 10) || 1),
            comp.remarks || null, comp.status || 'present'
          ]
        );
      }
    }

    // Insert multiple products (ASUS multi-item sales orders: repeatable device
    // blocks + accessory rows)
    if (mergedProducts.length > 0) {
      for (const prod of mergedProducts) {
        const qty = parseInt(srcVal(prod, 'quantity', 'quantity'), 10) || 1;
        const rate = parseFloat(srcVal(prod, 'rate', 'rate')) || 0;
        const lineAmt = parseFloat(srcVal(prod, 'amount', 'amount')) || (qty * rate);
        const specs = srcVal(prod, 'specifications', 'specifications');
        const specsJson = specs && typeof specs === 'object' && !Array.isArray(specs)
          ? JSON.stringify(Object.fromEntries(Object.entries(specs).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')))
          : null;
        await client.query(
          `INSERT INTO order_products (order_id, product_name, product_model, serial_number, warranty, quantity, rate, amount, accessory_type, part_no, check_no, series, specifications, brand)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            orderId,
            srcVal(prod, 'productName', 'product_name'),
            srcVal(prod, 'productModel', 'product_model') || null,
            srcVal(prod, 'serialNumber', 'serial_number') || null,
            srcVal(prod, 'warranty', 'warranty') || null,
            qty,
            rate,
            lineAmt,
            srcVal(prod, 'accessoryType', 'accessory_type') || null,
            srcVal(prod, 'partNo', 'part_no') || null,
            srcVal(prod, 'checkNo', 'check_no') || null,
            srcVal(prod, 'series', 'series') || null,
            specsJson,
            srcVal(prod, 'brand', 'brand') || null,
          ]
        );
      }
    }

    // Upsert the customer profile (name, phone, email, address, GSTIN) so the
    // order form / customer history can auto-fill returning customers.
    await client.query('SAVEPOINT cust_upsert_sp');
    try {
      const cleanPhone = String(mobileNumber || '').trim();
      const phoneDigits = String(mobileNumber || '').replace(/[^\d]/g, '').replace(/^0+/, '');
      if (customerName && phoneDigits) {
        let cust = null;
        const exact = await client.query(
          'SELECT * FROM customers WHERE phone = $1 OR phone2 = $1 ORDER BY id DESC LIMIT 1',
          [cleanPhone]
        );
        cust = exact.rows[0] || null;
        if (!cust && phoneDigits.length >= 10) {
          const like = await client.query(
            'SELECT * FROM customers WHERE phone ILIKE $1 OR phone2 ILIKE $1 ORDER BY id DESC LIMIT 1',
            [`%${phoneDigits.slice(-10)}`]
          );
          cust = like.rows[0] || null;
        }
        if (cust) {
          const sets = [];
          const vals = [];
          let i = 1;
          const flds = [
            ['name', String(customerName || '').trim()],
            ['email', email ? String(email).trim() : ''],
            ['address', address ? String(address).trim() : ''],
            ['gstin', gstin ? String(gstin).trim() : ''],
          ];
          for (const [col, v] of flds) {
            if (v) { sets.push(`${col} = $${i}`); vals.push(v); i++; }
          }
          if (sets.length > 0) {
            vals.push(cust.id);
            await client.query(
              `UPDATE customers SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i}`,
              vals
            );
          }
        } else {
          await client.query(
            `INSERT INTO customers (name, phone, email, address, gstin, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
            [String(customerName).trim(), cleanPhone, email || null, address || null, gstin || null]
          );
        }
      }
      await client.query('RELEASE SAVEPOINT cust_upsert_sp');
    } catch (e) {
      console.error('Customer upsert skipped (order will still be saved):', e.message);
      await client.query('ROLLBACK TO SAVEPOINT cust_upsert_sp');
    }

    // When a real order is created for a customer who has a pending advanced
    // booking, mark that booking as completed and link it to this order so the
    // order form no longer shows the "Advanced Paid" badge for them.
    if (!isBooking) {
      const phoneDigitsL10 = String(mobileNumber || '').replace(/[^\d]/g, '').replace(/^0+/, '').slice(-10);
      if (phoneDigitsL10) {
        await client.query(
          `UPDATE orders SET booking_status = 'completed', linked_order_id = $1, updated_at = NOW()
           WHERE is_active = true
             AND store_id = $2
             AND booking_type = 'advanced'
             AND booking_status = 'pending'
             AND right(regexp_replace(mobile_number, '\\D', '', 'g'), 10) = $3`,
          [orderId, storeId || null, phoneDigitsL10]
        );
      }
    }

    await client.query('COMMIT');

    const newOrder = await client.query(
      `SELECT o.*, COALESCE(json_agg(json_build_object(
        'id', oc.id, 'component_name', oc.component_name,
        'description', oc.description, 'warranty', oc.warranty,
        'quantity', oc.quantity, 'price', oc.price, 'amount', oc.amount,
        'remarks', oc.remarks, 'status', oc.status
      )) FILTER (WHERE oc.id IS NOT NULL), '[]'::json) AS components,
      COALESCE((
        SELECT json_agg(json_build_object(
          'id', op.id, 'product_name', op.product_name,
          'product_model', op.product_model, 'serial_number', op.serial_number,
          'warranty', op.warranty, 'quantity', op.quantity,
          'rate', op.rate, 'amount', op.amount,
          'accessory_type', op.accessory_type, 'part_no', op.part_no, 'check_no', op.check_no, 'series', op.series, 'brand', op.brand, 'specifications', op.specifications
        ))
        FROM order_products op WHERE op.order_id = o.id
      ), '[]'::json) AS products
      FROM orders o
      LEFT JOIN order_components oc ON oc.order_id = o.id
      WHERE o.id = $1
      GROUP BY o.id`,
      [orderId]
    );

    // Advanced bookings are not final sales: skip WhatsApp / invoice auto-send.
    if (!isBooking) {
    setImmediate(async () => {
      try {
        const orderData = newOrder.rows[0];
        const phone = orderData.mobile_number;

        // 1. Send template message first (falls back to text messages if template fails)
        try {
          const store = await getStoreInfo(orderData?.store_id);
          const result = await notifyOrderCreated(orderData, store);
          if (!result?.template?.success) {
            console.error('WhatsApp order_created template failed:', JSON.stringify({ error: result?.templateError, fallback: result?.templateFallback }));
          }
        } catch (e) {
          console.error('WhatsApp notification error:', e.stack || e.message);
        }

        // 2. Send the order invoice via the approved "order_invoice" template
        //    with the invoice PDF attached. Every store (Bluechip included)
        //    follows this same path — the PDF automatically carries that
        //    store's own details. The old order-form / "order inward" PDF is
        //    no longer auto-sent.
        if (!phone) return;
        try {
          const custConvId = getConversationIdFromPhone(phone);
          const pdf = await generateOrderInvoicePdf(orderId);
          const fileMsg = await createPdfMessage({
            conversationId: custConvId,
            orderId: orderId,
            sender: 'System',
            fileName: pdf.fileName,
            fileSize: pdf.fileSize,
            documentType: 'order_invoice',
            event: 'Order invoice generated',
            phone: phone,
          });
          if (pdf.filePath) {
            const forwardResult = await sendOrderInvoiceTemplate(orderData, pdf.filePath).catch(e => {
              console.error('Auto-send order invoice template failed:', e.message);
              return null;
            });
            if (forwardResult && forwardResult.success && forwardResult.messageId) {
              await updateMessageStatusById(fileMsg.id, forwardResult.messageId, 'sent');
            } else if (forwardResult && !forwardResult.success && !forwardResult.skipped) {
              await updateMessageStatusById(fileMsg.id, null, 'failed');
            }
          }
        } catch (e) {
          console.error('Auto-generate order invoice failed:', e.message);
        }
} catch (e) {
          console.error('Order auto-notification error:', e.stack || e.message);
        }
      });
    } else {
      // Advanced booking: generate the challan PDF and send it to the customer
      // via the approved "booking_challan" WhatsApp template.
      setImmediate(async () => {
        try {
          const orderData = newOrder.rows[0];
          const phone = orderData.mobile_number;
          if (!phone) return;
          const sendStore = await getStoreInfo(orderData?.store_id);
          const bookingResult = await notifyBookingCreated(orderData, sendStore);
          if (!bookingResult?.success) {
            console.error('WhatsApp booking_challan template failed:', JSON.stringify({ error: bookingResult?.error, result: bookingResult }));
          }
        } catch (e) {
          console.error('Booking challan notification error:', e.stack || e.message);
        }
      });
    }

    res.status(201).json({ success: true, message: 'Order created successfully', data: newOrder.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PUT /api/orders/:id - Update order
router.put('/:id', async (req, res, next) => {
  const client = await getConnection();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const updates = req.body;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

    // Calculate financial values
    const serviceAmt = parseFloat(updates.serviceAmount ?? existing.rows[0].service_amount) || 0;
    const partsAmt = parseFloat(updates.partsAmount ?? existing.rows[0].parts_amount) || 0;
    const additional = parseFloat(updates.additionalCharges ?? existing.rows[0].additional_charges) || 0;
    const disc = parseFloat(updates.discount ?? existing.rows[0].discount) || 0;

    // Calculate enhanced financials from components
    const comps = Array.isArray(updates.components) ? updates.components : [];
    const componentsTotal = comps.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);
    // Repeatable ASUS device blocks + accessory rows all live in order_products.
    const mergedProducts = mergeOrderProducts(updates.devices, updates.products);
    const productsTotal = sumOrderProducts(mergedProducts);

    const subtotal = serviceAmt + componentsTotal + productsTotal;
    const gstRate = 0.18;
    // Customer amounts are GST-inclusive: back the GST out and never add it on top.
    const gstAmount = subtotal - (subtotal / (1 + gstRate));
    const grandTotal = subtotal - disc;

    const advance = parseFloat(updates.advancePayment ?? existing.rows[0].advance_payment) || 0;
    const remainingBalance = grandTotal - advance;

    // Regular orders are always Paid (payment received at the counter);
    // only advanced bookings are classified from advance vs. balance.
    const isBookingOrder = String(existing.rows[0].booking_type || '') === 'advanced';
    let paymentStatus;
    if (isBookingOrder) {
      if (updates.paymentStatus === 'Paid' || updates.paymentStatus === 'Unpaid' || updates.paymentStatus === 'Partially Paid') {
        paymentStatus = updates.paymentStatus;
      } else {
        paymentStatus = computePaymentStatus(advance, remainingBalance);
      }
    } else {
      paymentStatus = 'Paid';
    }

    const fieldMapping = {
      customerName: 'customer_name',
      mobileNumber: 'mobile_number',
      email: 'email',
      address: 'address',
      orderDate: 'order_date',
      deviceType: 'device_type',
      desktopType: 'desktop_type',
      paymentType: 'payment_type',
      deliveryDate: 'delivery_date',
      brand: 'brand',
      model: 'model',
      serialNumber: 'serial_number',
      problemDescription: 'problem_description',
      orderNote: 'order_note',
      createdBy: 'created_by',
      storeId: 'store_id',
      warranty: 'warranty',
      accessoryType: 'accessory_type',
      customAccessory: 'custom_accessory',
      partNo: 'part_no',
      checkNo: 'check_no',
      remark: 'remark',
      gstin: 'gstin',
      advancePaymentMode: 'advance_payment_mode',
      financeDownPayment: 'finance_down_payment',
      financeEmi: 'finance_emi',
      financeDuration: 'finance_duration',
    };

    const setClauses = ['service_amount = $1', 'parts_amount = $2', 'additional_charges = $3',
      'discount = $4', 'total_amount = $5', 'advance_payment = $6',
      'remaining_balance = $7', 'payment_status = $8', 'updated_at = $9',
      'subtotal = $10', 'gst_amount = $11', 'grand_total = $12'];
    const updateValues = [serviceAmt, partsAmt, additional, disc, grandTotal,
      advance, remainingBalance, paymentStatus, now, subtotal, gstAmount, grandTotal];
    let paramIdx = 13;

    // Payment modes are free text on the form, so trim + cap them to their
    // column width. payment_type is NOT NULL: an empty box keeps 'Cash'.
    const normalisePaymentText = (value, maxLen, fallback) => {
      if (value === undefined) return undefined;
      const cleaned = String(value || '').trim().slice(0, maxLen);
      return cleaned || fallback;
    };

    for (const [frontField, dbField] of Object.entries(fieldMapping)) {
      if (updates[frontField] !== undefined) {
        let value = updates[frontField];
        if (frontField === 'paymentType') {
          value = normalisePaymentText(value, 50, 'Cash');
        } else if (frontField === 'advancePaymentMode') {
          value = normalisePaymentText(value, 100, null);
        }
        setClauses.push(`${dbField} = $${paramIdx}`);
        updateValues.push(value);
        paramIdx++;
      }
    }

    updateValues.push(req.params.id);
    await client.query(
      `UPDATE orders SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`,
      updateValues
    );

    // Update components if provided
    if (Array.isArray(updates.components)) {
      await client.query('DELETE FROM order_components WHERE order_id = $1', [req.params.id]);
      for (const comp of updates.components) {
        await client.query(
          `INSERT INTO order_components (order_id, component_name, description, warranty, quantity, price, amount, remarks, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            req.params.id, comp.componentName,
            comp.description || null, comp.warranty || null,
            comp.quantity || 1, parseFloat(comp.price) || 0,
            parseFloat(comp.amount) || (parseFloat(comp.price) || 0) * (parseInt(comp.quantity, 10) || 1),
            comp.remarks || null, comp.status || 'present'
          ]
        );
      }
    }

    // Update products if provided (ASUS multi-item sales orders - repeatable
    // device blocks + accessory rows)
    if (Array.isArray(updates.products) || Array.isArray(updates.devices)) {
      await client.query('DELETE FROM order_products WHERE order_id = $1', [req.params.id]);
      for (const prod of mergedProducts) {
        const qty = parseInt(srcVal(prod, 'quantity', 'quantity'), 10) || 1;
        const rate = parseFloat(srcVal(prod, 'rate', 'rate')) || 0;
        const lineAmt = parseFloat(srcVal(prod, 'amount', 'amount')) || (qty * rate);
        const specs = srcVal(prod, 'specifications', 'specifications');
        const specsJson = specs && typeof specs === 'object' && !Array.isArray(specs)
          ? JSON.stringify(Object.fromEntries(Object.entries(specs).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')))
          : null;
        await client.query(
          `INSERT INTO order_products (order_id, product_name, product_model, serial_number, warranty, quantity, rate, amount, accessory_type, part_no, check_no, series, specifications, brand)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            req.params.id,
            srcVal(prod, 'productName', 'product_name'),
            srcVal(prod, 'productModel', 'product_model') || null,
            srcVal(prod, 'serialNumber', 'serial_number') || null,
            srcVal(prod, 'warranty', 'warranty') || null,
            qty,
            rate,
            lineAmt,
            srcVal(prod, 'accessoryType', 'accessory_type') || null,
            srcVal(prod, 'partNo', 'part_no') || null,
            srcVal(prod, 'checkNo', 'check_no') || null,
            srcVal(prod, 'series', 'series') || null,
            specsJson,
            srcVal(prod, 'brand', 'brand') || null,
          ]
        );
      }
    }

    await client.query('COMMIT');

    const updated = await client.query(
      `SELECT o.*, COALESCE(json_agg(json_build_object(
        'id', oc.id, 'component_name', oc.component_name,
        'description', oc.description, 'warranty', oc.warranty,
        'quantity', oc.quantity, 'price', oc.price, 'amount', oc.amount,
        'remarks', oc.remarks, 'status', oc.status
      )) FILTER (WHERE oc.id IS NOT NULL), '[]'::json) AS components,
      COALESCE((
        SELECT json_agg(json_build_object(
          'id', op.id, 'product_name', op.product_name,
          'product_model', op.product_model, 'serial_number', op.serial_number,
          'warranty', op.warranty, 'quantity', op.quantity,
          'rate', op.rate, 'amount', op.amount,
          'accessory_type', op.accessory_type, 'part_no', op.part_no, 'check_no', op.check_no, 'series', op.series, 'brand', op.brand, 'specifications', op.specifications
        ))
        FROM order_products op WHERE op.order_id = o.id
      ), '[]'::json) AS products
      FROM orders o
      LEFT JOIN order_components oc ON oc.order_id = o.id
      WHERE o.id = $1
      GROUP BY o.id`,
      [req.params.id]
    );

    // Auto-send the updated invoice to the customer on WhatsApp when the save
    // explicitly requests it (Manage Orders "Save" flow). Fire-and-forget so
    // the save response is not blocked by PDF generation / message delivery.
    // Every store (Bluechip included) sends the "order_invoice" template with
    // the invoice PDF attached; the order-form / "order inward" PDF is no
    // longer auto-sent.
    if (req.body.autoSendWhatsapp === true) {
      const orderId = req.params.id;
      const sentOrderData = updated.rows[0];
      setImmediate(async () => {
        try {
          const phone = sentOrderData && sentOrderData.mobile_number;
          if (!phone) return;
          const custConvId = getConversationIdFromPhone(phone);
          const pdf = await generateOrderInvoicePdf(orderId);
          const fileMsg = await createPdfMessage({
            conversationId: custConvId,
            orderId: parseInt(orderId, 10),
            sender: 'System',
            fileName: pdf.fileName,
            fileSize: pdf.fileSize,
            documentType: 'order_invoice',
            event: 'Updated order invoice generated',
            phone: phone,
          });
          if (pdf.filePath) {
            const forwardResult = await sendOrderInvoiceTemplate(sentOrderData, pdf.filePath).catch(e => {
              console.error('Auto-send updated order invoice template failed:', e.message);
              return null;
            });
            if (forwardResult && forwardResult.success && forwardResult.messageId) {
              await updateMessageStatusById(fileMsg.id, forwardResult.messageId, 'sent');
            } else if (forwardResult && !forwardResult.success && !forwardResult.skipped) {
              await updateMessageStatusById(fileMsg.id, null, 'failed');
            }
          }
        } catch (e) {
          console.error('Auto-send updated order invoice failed:', e.stack || e.message);
        }
      });
    }

    res.json({ success: true, message: 'Order updated successfully', data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/orders/:id - Permanently delete the order and all of its entries
router.delete('/:id', async (req, res, next) => {
  const client = await getConnection();
  const orderId = parseInt(req.params.id, 10);
  if (isNaN(orderId)) {
    client.release();
    return res.status(400).json({ success: false, message: 'Invalid order id' });
  }
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM orders WHERE id = $1', [orderId]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // Delete any PDF records whose owning invoices belong to this order.
    await client.query(
      `DELETE FROM invoice_pdfs WHERE invoice_id IN (SELECT id FROM invoices WHERE order_id = $1)`,
      [orderId]
    );

    // Delete invoices generated from this order.
    await client.query(`DELETE FROM invoices WHERE order_id = $1`, [orderId]);

    // Delete chat / WhatsApp log entries linked to this order.
    await client.query(`DELETE FROM messages WHERE order_id = $1`, [orderId]);
    await client.query(`DELETE FROM whatsapp_message_log WHERE order_id = $1`, [orderId]);

    // Delete the order's components (cascades automatically as a safety net).
    await client.query(`DELETE FROM order_components WHERE order_id = $1`, [orderId]);

    // Finally remove the order itself.
    await client.query(`DELETE FROM orders WHERE id = $1`, [orderId]);

    await client.query('COMMIT');
    res.json({ success: true, message: 'Order deleted successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PUT /api/orders/:id/payment - Update advance payment
router.put('/:id/payment', async (req, res, next) => {
  const client = await getConnection();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const order = existing.rows[0];
    const advancePayment = parseFloat(req.body.advancePayment) || 0;
    const paymentType = req.body.paymentType || order.payment_type;

    if (advancePayment > order.total_amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Advance payment cannot exceed total amount' });
    }

    const remainingBalance = order.total_amount - advancePayment;
    const paymentStatus = computePaymentStatus(advancePayment, remainingBalance);

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await client.query(
      `UPDATE orders SET advance_payment = $1, remaining_balance = $2, payment_status = $3, payment_type = $4, updated_at = $5 WHERE id = $6`,
      [advancePayment, remainingBalance, paymentStatus, paymentType, now, req.params.id]
    );

    await client.query('COMMIT');

    const updated = await client.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Payment updated successfully', data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
