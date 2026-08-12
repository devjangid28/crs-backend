const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { query, getConnection } = require('../config/database');
const { authenticate } = require('../middleware/auth');

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

async function generateQuotationNumber(client) {
  const today = new Date();
  const y = today.getFullYear();
  const prefix = `QT- BCCS-${String.fromCharCode(65 + today.getMonth())}${String(today.getDate()).padStart(2, '0')}/${y}-${(y + 1) % 100}`;
  return prefix;
}

async function ensureTable(client) {
  const q = client ? client.query.bind(client) : query;
  await q(`
    CREATE TABLE IF NOT EXISTS quotations (
      id SERIAL PRIMARY KEY,
      quotation_number VARCHAR(50) NOT NULL UNIQUE,
      customer_id INTEGER DEFAULT NULL,
      customer_name VARCHAR(150) NOT NULL,
      customer_phone VARCHAR(20) DEFAULT NULL,
      customer_email VARCHAR(191) DEFAULT NULL,
      customer_address TEXT DEFAULT NULL,
      company_name VARCHAR(200) DEFAULT NULL,
      contact_person VARCHAR(150) DEFAULT NULL,
      kind_attention VARCHAR(200) DEFAULT NULL,
      quotation_date DATE NOT NULL DEFAULT CURRENT_DATE,
      valid_until DATE DEFAULT NULL,
      reference_text TEXT DEFAULT NULL,
      items JSONB DEFAULT '[]'::jsonb,
      subtotal DECIMAL(12,2) DEFAULT 0.00,
      tax_rate DECIMAL(5,2) DEFAULT 18.00,
      tax_amount DECIMAL(12,2) DEFAULT 0.00,
      discount DECIMAL(12,2) DEFAULT 0.00,
      total_amount DECIMAL(12,2) DEFAULT 0.00,
      terms_conditions TEXT DEFAULT NULL,
      bank_details TEXT DEFAULT NULL,
      closing_message TEXT DEFAULT NULL,
      sign_off_text TEXT DEFAULT 'For BLUECHIP COMPUTER SYSTEM',
      status VARCHAR(20) NOT NULL DEFAULT 'Draft',
      created_by VARCHAR(100) DEFAULT 'System',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// GET /api/quotations - List quotations
router.get('/', authenticate, async (req, res, next) => {
  try {
    await ensureTable();
    const { search, status, page = 1, limit = 50 } = req.query;
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (search) {
      whereClause += ` AND (quotation_number ILIKE $${params.length + 1} OR customer_name ILIKE $${params.length + 2} OR kind_attention ILIKE $${params.length + 3})`;
      const s = `%${search}%`;
      params.push(s, s, s);
    }

    if (status) {
      whereClause += ` AND status = $${params.length + 1}`;
      params.push(status);
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const countResult = await query(`SELECT COUNT(*) as total FROM quotations ${whereClause}`, params);
    const total = parseInt(countResult.rows[0]?.total) || 0;

    const dataResult = await query(
      `SELECT * FROM quotations ${whereClause}
       ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(limit), offset]
    );

    res.json({
      success: true,
      data: dataResult.rows,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/quotations/next-number - Get next quotation number
router.get('/next-number', authenticate, async (req, res, next) => {
  try {
    await ensureTable();
    const now = new Date();
    const y = now.getFullYear();
    const month = MONTHS[now.getMonth()];
    const letter = String.fromCharCode(65 + now.getMonth());
    const prefix = `QT- BCCS-${letter}${String(now.getDate()).padStart(2, '0')}/${y}-${String((y + 1) % 100).padStart(2, '0')}`;
    res.json({ success: true, data: { number: prefix, date: now.toLocaleDateString('en-GB') } });
  } catch (err) {
    next(err);
  }
});

// GET /api/quotations/:id - Single quotation
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    await ensureTable();
    const result = await query('SELECT * FROM quotations WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Quotation not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/quotations - Create quotation
router.post('/', authenticate, async (req, res, next) => {
  const client = await getConnection();
  try {
    await client.query('BEGIN');
    await ensureTable(client);

    const {
      quotationNumber, customerId, customerName, customerPhone, customerEmail,
      customerAddress, companyName, contactPerson, kindAttention,
      quotationDate, validUntil, referenceText, items = [],
      taxRate = 18, discount = 0, termsConditions, bankDetails,
      closingMessage, signOffText, status = 'Draft'
    } = req.body;

    if (!customerName || !customerName.trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Customer name is required' });
    }

    const number = quotationNumber || await generateQuotationNumber(client);

    // Calculate totals
    const parsedItems = (Array.isArray(items) ? items : []).map(item => ({
      sn: item.sn || 0,
      productName: item.productName || item.product_name || '',
      description: item.description || '',
      qty: parseInt(item.qty) || 1,
      price: parseFloat(item.price) || 0,
      amount: parseFloat(item.amount) || (parseInt(item.qty) || 1) * (parseFloat(item.price) || 0),
    }));

    const subtotal = parsedItems.reduce((sum, item) => sum + item.amount, 0);
    const taxAmount = subtotal * (parseFloat(taxRate) || 0) / 100;
    const totalAmount = subtotal + taxAmount - (parseFloat(discount) || 0);

    const result = await client.query(
      `INSERT INTO quotations (
        quotation_number, customer_id, customer_name, customer_phone, customer_email,
        customer_address, company_name, contact_person, kind_attention,
        quotation_date, valid_until, reference_text, items, subtotal, tax_rate,
        tax_amount, discount, total_amount, terms_conditions, bank_details,
        closing_message, sign_off_text, status, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
      RETURNING *`,
      [
        number, customerId || null, customerName, customerPhone || null, customerEmail || null,
        customerAddress || null, companyName || null, contactPerson || null, kindAttention || null,
        quotationDate || new Date().toISOString().slice(0, 10), validUntil || null, referenceText || null,
        JSON.stringify(parsedItems), subtotal, parseFloat(taxRate) || 0,
        taxAmount, parseFloat(discount) || 0, totalAmount, termsConditions || null, bankDetails || null,
        closingMessage || null, signOffText || 'For BLUECHIP COMPUTER SYSTEM', status, req.user.full_name || 'System'
      ]
    );

    await client.query('COMMIT');
    res.status(201).json({ success: true, message: 'Quotation created successfully', data: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PUT /api/quotations/:id - Update quotation
router.put('/:id', authenticate, async (req, res, next) => {
  try {
    await ensureTable();
    const existing = await query('SELECT * FROM quotations WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Quotation not found' });
    }

    const updates = req.body;
    const fieldMapping = {
      quotationNumber: 'quotation_number', customerId: 'customer_id',
      customerName: 'customer_name', customerPhone: 'customer_phone',
      customerEmail: 'customer_email', customerAddress: 'customer_address',
      companyName: 'company_name', contactPerson: 'contact_person',
      kindAttention: 'kind_attention', quotationDate: 'quotation_date',
      validUntil: 'valid_until', referenceText: 'reference_text',
      termsConditions: 'terms_conditions', bankDetails: 'bank_details',
      closingMessage: 'closing_message', signOffText: 'sign_off_text',
      status: 'status'
    };

    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const [front, db] of Object.entries(fieldMapping)) {
      if (updates[front] !== undefined) {
        setClauses.push(`${db} = $${idx++}`);
        values.push(updates[front]);
      }
    }

    // Handle items recalculation
    if (updates.items !== undefined && Array.isArray(updates.items)) {
      const parsedItems = updates.items.map(item => ({
        sn: item.sn || 0,
        productName: item.productName || item.product_name || '',
        description: item.description || '',
        qty: parseInt(item.qty) || 1,
        price: parseFloat(item.price) || 0,
        amount: parseFloat(item.amount) || (parseInt(item.qty) || 1) * (parseFloat(item.price) || 0),
      }));
      const subtotal = parsedItems.reduce((sum, item) => sum + item.amount, 0);
      const taxRate = parseFloat(updates.taxRate ?? existing.rows[0].tax_rate) || 0;
      const discount = parseFloat(updates.discount ?? existing.rows[0].discount) || 0;
      const taxAmount = subtotal * taxRate / 100;
      const totalAmount = subtotal + taxAmount - discount;

      setClauses.push(`items = $${idx++}`, `subtotal = $${idx++}`, `tax_rate = $${idx++}`, `tax_amount = $${idx++}`, `discount = $${idx++}`, `total_amount = $${idx++}`);
      values.push(JSON.stringify(parsedItems), subtotal, taxRate, taxAmount, discount, totalAmount);
    } else if (updates.taxRate !== undefined || updates.discount !== undefined) {
      const currentItems = existing.rows[0].items || [];
      const subtotal = (Array.isArray(currentItems) ? currentItems : []).reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
      const taxRate = parseFloat(updates.taxRate ?? existing.rows[0].tax_rate) || 0;
      const discount = parseFloat(updates.discount ?? existing.rows[0].discount) || 0;
      const taxAmount = subtotal * taxRate / 100;
      const totalAmount = subtotal + taxAmount - discount;
      setClauses.push(`tax_rate = $${idx++}`, `tax_amount = $${idx++}`, `discount = $${idx++}`, `total_amount = $${idx++}`);
      values.push(taxRate, taxAmount, discount, totalAmount);
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    values.push(req.params.id);
    await query(
      `UPDATE quotations SET ${setClauses.join(', ')} WHERE id = $${idx}`,
      values
    );

    const updated = await query('SELECT * FROM quotations WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Quotation updated successfully', data: updated.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/quotations/:id - Soft delete
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    await ensureTable();
    await query('DELETE FROM quotations WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Quotation deleted successfully' });
  } catch (err) {
    next(err);
  }
});

// GET /api/quotations/:id/preview - Return Quotation.html with data filled in
router.get('/:id/preview', authenticate, async (req, res, next) => {
  try {
    await ensureTable();
    const result = await query('SELECT * FROM quotations WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Quotation not found' });
    }
    const quotation = result.rows[0];

    // Load Quotation.html template
    let templatePath = path.join(__dirname, '..', '..', '..', 'Quotation.html');
    if (!fs.existsSync(templatePath)) {
      templatePath = path.join(__dirname, '..', '..', 'public', 'Quotation.html');
    }
    if (!fs.existsSync(templatePath)) {
      templatePath = path.join(__dirname, '..', '..', '..', 'public', 'Quotation.html');
    }
    if (!fs.existsSync(templatePath)) {
      return res.status(500).json({ success: false, message: 'Quotation.html template not found' });
    }

    let html = fs.readFileSync(templatePath, 'utf-8');

    // Inject data as JSON for client-side population
    html = html.replace(
      '<body>',
      `<body>\n<script>window.__QUOTATION_DATA__ = ${JSON.stringify(quotation)};</script>`
    );

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    next(err);
  }
});

// GET /api/quotations/:id/download - Download Quotation.html as file
router.get('/:id/download', authenticate, async (req, res, next) => {
  try {
    await ensureTable();
    const result = await query('SELECT * FROM quotations WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Quotation not found' });
    }
    const quotation = result.rows[0];

    let templatePath = path.join(__dirname, '..', '..', '..', 'Quotation.html');
    if (!fs.existsSync(templatePath)) {
      templatePath = path.join(__dirname, '..', '..', 'public', 'Quotation.html');
    }
    if (!fs.existsSync(templatePath)) {
      templatePath = path.join(__dirname, '..', '..', '..', 'public', 'Quotation.html');
    }
    if (!fs.existsSync(templatePath)) {
      return res.status(500).json({ success: false, message: 'Quotation.html template not found' });
    }

    let html = fs.readFileSync(templatePath, 'utf-8');

    html = html.replace(
      '<body>',
      `<body>\n<script>window.__QUOTATION_DATA__ = ${JSON.stringify(quotation)};</script>`
    );

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="${quotation.quotation_number.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_')}.html"`);
    res.send(html);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
