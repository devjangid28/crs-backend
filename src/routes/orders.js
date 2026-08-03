const express = require('express');
const router = express.Router();
const { query, getConnection } = require('../config/database');
const { notifyOrderCreated, sendDocumentFile, getConversationIdFromPhone } = require('../services/whatsappService');
const { generateOrderPdfFromHTML } = require('../services/pdfGenerator');
const { createPdfMessage } = require('../services/messagingService');

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
    const { search, paymentStatus, deviceType, date, page = 1, limit = 50 } = req.query;
    let whereClause = 'WHERE o.is_active = true';
    const params = [];

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
    )) FILTER (WHERE oc.id IS NOT NULL), '[]'::json) AS components
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

// GET /api/orders/:id - Get single order with components
router.get('/:id', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT o.*, COALESCE(json_agg(json_build_object(
        'id', oc.id, 'component_name', oc.component_name,
        'description', oc.description, 'warranty', oc.warranty,
        'quantity', oc.quantity, 'price', oc.price, 'amount', oc.amount,
        'remarks', oc.remarks, 'status', oc.status
      )) FILTER (WHERE oc.id IS NOT NULL), '[]'::json) AS components
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
      customerName, mobileNumber, address, orderDate, deviceType,
      desktopType, brand, model, serialNumber, problemDescription, orderNote,
      serviceAmount = 0, partsAmount = 0, additionalCharges = 0,
      discount = 0, advancePayment = 0, advancePaymentMode,
      paymentType = 'Cash',
      deliveryDate, createdBy, components = [], storeId, specifications
    } = req.body;

    const serviceAmt = parseFloat(serviceAmount) || 0;
    const partsAmt = parseFloat(partsAmount) || 0;
    const additional = parseFloat(additionalCharges) || 0;
    const disc = parseFloat(discount) || 0;

    // Calculate component totals
    const componentsTotal = Array.isArray(components) ? components.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0) : 0;
    const subtotal = serviceAmt + componentsTotal;
    const gstRate = 0.18;
    const gstAmount = subtotal * gstRate;
    const grandTotal = subtotal + gstAmount - disc;

    const advance = parseFloat(advancePayment) || 0;
    const remainingBalance = grandTotal - advance;

    let paymentStatus = 'Unpaid';
    if (advance > 0 && remainingBalance === 0) paymentStatus = 'Paid';
    else if (advance > 0 && remainingBalance > 0) paymentStatus = 'Partially Paid';

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const orderDateVal = orderDate || new Date().toISOString().slice(0, 10);

    const specsJson = specifications && Array.isArray(specifications) && specifications.length > 0
      ? JSON.stringify(specifications)
      : null;

    const insertResult = await client.query(
      `INSERT INTO orders (
        order_number, customer_name, mobile_number, address, order_date,
        device_type, desktop_type, brand, model, serial_number,
        problem_description, order_note, delivery_date, service_amount, parts_amount,
        additional_charges, discount, total_amount, advance_payment,
        advance_payment_mode, remaining_balance, payment_status, payment_type, created_by,
        store_id, subtotal, gst_amount, grand_total, specifications, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
      RETURNING id`,
      [
        orderNumber, customerName, mobileNumber, address, orderDateVal,
        deviceType, desktopType || null, brand || null, model || null, serialNumber || null,
        problemDescription || null, orderNote || null, deliveryDate || null,
        serviceAmt, partsAmt, additional, disc, grandTotal,
        advance, advancePaymentMode || null, remainingBalance, paymentStatus, paymentType, createdBy || null,
        storeId || null, subtotal, gstAmount, grandTotal, specsJson, now, now
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
            parseFloat(comp.amount) || 0,
            comp.remarks || null, comp.status || 'present'
          ]
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
      )) FILTER (WHERE oc.id IS NOT NULL), '[]'::json) AS components
      FROM orders o
      LEFT JOIN order_components oc ON oc.order_id = o.id
      WHERE o.id = $1
      GROUP BY o.id`,
      [orderId]
    );

    setImmediate(async () => {
      try {
        const store = await getStoreInfo(newOrder.rows[0]?.store_id);
        const result = await notifyOrderCreated(newOrder.rows[0], store);
        if (!result?.template?.success) {
          console.error('WhatsApp order_created template failed:', JSON.stringify({ error: result?.templateError, fallback: result?.templateFallback }));
        }
      } catch (e) {
        console.error('WhatsApp notification error:', e.stack || e.message);
      }
    });

    // Auto-send orderform PDF after 30 seconds (fire-and-forget)
    setImmediate(async () => {
      try {
        await new Promise(resolve => setTimeout(resolve, 30000));
        const orderData = newOrder.rows[0];
        const phone = orderData.mobile_number;
        const custConvId = getConversationIdFromPhone(phone);
        const pdf = await generateOrderPdfFromHTML(orderId);
        await createPdfMessage({
          conversationId: custConvId,
          orderId: orderId,
          sender: 'System',
          fileName: pdf.fileName,
          fileSize: pdf.fileSize,
          documentType: 'order_form',
          event: 'Order form generated',
          phone: phone,
        });
        if (phone && pdf.filePath) {
          sendDocumentFile(phone, pdf.filePath, `Order Form - ${orderData.order_number || ''}`, {
            orderId: orderId,
            conversationId: custConvId,
            sender: 'System',
          }).catch(e => console.error('Auto-send order form PDF failed:', e.message));
        }
      } catch (e) {
        console.error('Auto-generate order form failed:', e.message);
      }
    });

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
    const subtotal = serviceAmt + componentsTotal;
    const gstRate = 0.18;
    const gstAmount = subtotal * gstRate;
    const grandTotal = subtotal + gstAmount - disc;

    const advance = parseFloat(updates.advancePayment ?? existing.rows[0].advance_payment) || 0;
    const remainingBalance = grandTotal - advance;

    let paymentStatus = 'Unpaid';
    if (advance > 0 && remainingBalance === 0) paymentStatus = 'Paid';
    else if (advance > 0 && remainingBalance > 0) paymentStatus = 'Partially Paid';

    const fieldMapping = {
      customerName: 'customer_name',
      mobileNumber: 'mobile_number',
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
    };

    const setClauses = ['service_amount = $1', 'parts_amount = $2', 'additional_charges = $3',
      'discount = $4', 'total_amount = $5', 'advance_payment = $6',
      'remaining_balance = $7', 'payment_status = $8', 'updated_at = $9',
      'subtotal = $10', 'gst_amount = $11', 'grand_total = $12'];
    const updateValues = [serviceAmt, partsAmt, additional, disc, grandTotal,
      advance, remainingBalance, paymentStatus, now, subtotal, gstAmount, grandTotal];
    let paramIdx = 13;

    for (const [frontField, dbField] of Object.entries(fieldMapping)) {
      if (updates[frontField] !== undefined) {
        setClauses.push(`${dbField} = $${paramIdx}`);
        updateValues.push(updates[frontField]);
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
            parseFloat(comp.amount) || 0,
            comp.remarks || null, comp.status || 'present'
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
      )) FILTER (WHERE oc.id IS NOT NULL), '[]'::json) AS components
      FROM orders o
      LEFT JOIN order_components oc ON oc.order_id = o.id
      WHERE o.id = $1
      GROUP BY o.id`,
      [req.params.id]
    );

    res.json({ success: true, message: 'Order updated successfully', data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/orders/:id - Delete order (soft)
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await query('UPDATE orders SET is_active = false WHERE id = ?', [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    res.json({ success: true, message: 'Order deleted successfully' });
  } catch (err) {
    next(err);
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
    let paymentStatus = 'Unpaid';
    if (advancePayment > 0 && remainingBalance === 0) paymentStatus = 'Paid';
    else if (advancePayment > 0 && remainingBalance > 0) paymentStatus = 'Partially Paid';

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
