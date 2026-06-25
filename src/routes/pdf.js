const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { query } = require('../config/database');
const { generateInwardReceipt, generateInvoicePdf, generateOrderPdf } = require('../services/pdfGenerator');
const { logAudit, actions } = require('../services/auditService');
const { authenticate } = require('../middleware/auth');

const PDF_DIR = path.join(__dirname, '../../uploads/pdfs');

// POST /api/pdf/generate-inward/:ticketId - Generate inward receipt PDF
router.post('/generate-inward/:ticketId', authenticate, async (req, res, next) => {
  try {
    const ticketId = parseInt(req.params.ticketId);
    const pdf = await generateInwardReceipt(ticketId);

    // Ensure inward_receipts table has entry
    const tRes = await query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
    const t = tRes.rows[0];

    await query(
      `INSERT INTO inward_receipts (ticket_id, receipt_number, customer_name, customer_phone, device_details, serial_number, problem_description, accessories_received, pdf_path, pdf_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (receipt_number) DO UPDATE SET pdf_path = $9, pdf_size = $10`,
      [ticketId, pdf.receiptNumber, t.customer_name, t.customer_phone,
       `${t.device_type || ''} ${t.brand || ''} ${t.model || ''}`.trim(),
       t.serial_number, t.problem_description, t.accessories,
       pdf.filePath, pdf.fileSize]
    );

    await logAudit({
      action: actions.PDF_GENERATED,
      ticketId,
      entityType: 'inward_receipt',
      entityId: pdf.receiptNumber,
      performedBy: req.user?.full_name || 'Staff',
      details: { fileName: pdf.fileName, fileSize: pdf.fileSize, receiptNumber: pdf.receiptNumber },
    });

    res.json({
      success: true,
      data: {
        fileName: pdf.fileName,
        fileSize: pdf.fileSize,
        receiptNumber: pdf.receiptNumber,
        downloadUrl: `/api/pdf/download/inward/${ticketId}`,
      }
    });
  } catch (err) { next(err); }
});

// GET /api/pdf/download/inward/:ticketId - Download inward receipt PDF
router.get('/download/inward/:ticketId', async (req, res, next) => {
  try {
    const ticketId = parseInt(req.params.ticketId);
    const result = await query('SELECT * FROM inward_receipts WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT 1', [ticketId]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Inward receipt not found' });

    const receipt = result.rows[0];
    const filePath = receipt.pdf_path;

    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'PDF file not found' });
    }

    const fileName = path.basename(filePath);

    await logAudit({
      action: actions.PDF_VIEWED,
      ticketId,
      entityType: 'inward_receipt',
      entityId: receipt.receipt_number,
      performedBy: req.user?.full_name || 'Staff',
    });

    res.download(filePath, fileName);
  } catch (err) { next(err); }
});

// POST /api/pdf/generate-invoice/:invoiceId - Generate invoice PDF
router.post('/generate-invoice/:invoiceId', authenticate, async (req, res, next) => {
  try {
    const invoiceId = parseInt(req.params.invoiceId);
    const pdf = await generateInvoicePdf(invoiceId);

    await query(
      `INSERT INTO invoice_pdfs (invoice_id, pdf_path, pdf_size)
       VALUES ($1, $2, $3)`,
      [invoiceId, pdf.filePath, pdf.fileSize]
    );

    const iRes = await query('SELECT ticket_id FROM invoices WHERE id = $1', [invoiceId]);
    const ticketId = iRes.rows[0]?.ticket_id;

    await logAudit({
      action: actions.PDF_GENERATED,
      ticketId,
      entityType: 'invoice',
      entityId: String(invoiceId),
      performedBy: req.user?.full_name || 'Staff',
      details: { fileName: pdf.fileName, fileSize: pdf.fileSize },
    });

    res.json({
      success: true,
      data: {
        fileName: pdf.fileName,
        fileSize: pdf.fileSize,
        downloadUrl: `/api/pdf/download/invoice/${invoiceId}`,
      }
    });
  } catch (err) { next(err); }
});

// GET /api/pdf/download/invoice/:invoiceId - Download invoice PDF
router.get('/download/invoice/:invoiceId', async (req, res, next) => {
  try {
    const invoiceId = parseInt(req.params.invoiceId);
    const result = await query('SELECT * FROM invoice_pdfs WHERE invoice_id = $1 ORDER BY created_at DESC LIMIT 1', [invoiceId]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Invoice PDF not found' });

    const pdf = result.rows[0];
    const filePath = pdf.pdf_path;

    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'PDF file not found' });
    }

    const fileName = path.basename(filePath);

    const iRes = await query('SELECT ticket_id FROM invoices WHERE id = $1', [invoiceId]);

    await logAudit({
      action: actions.PDF_VIEWED,
      ticketId: iRes.rows[0]?.ticket_id,
      entityType: 'invoice',
      entityId: String(invoiceId),
      performedBy: req.user?.full_name || 'Staff',
    });

    res.download(filePath, fileName);
  } catch (err) { next(err); }
});

// POST /api/pdf/generate-order/:orderId - Generate order inward PDF
router.post('/generate-order/:orderId', authenticate, async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.orderId);
    const pdf = await generateOrderPdf(orderId);

    res.json({
      success: true,
      data: {
        fileName: pdf.fileName,
        fileSize: pdf.fileSize,
        downloadUrl: `/api/pdf/download/order/${orderId}`,
      }
    });
  } catch (err) { next(err); }
});

// GET /api/pdf/download/order/:orderId - Download order PDF
router.get('/download/order/:orderId', async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.orderId);
    const dir = path.join(PDF_DIR, 'orders');
    const files = fs.readdirSync(dir).filter(f => f.includes(`Order_Inward_ORD-`));
    const result = await query('SELECT order_number FROM orders WHERE id = $1', [orderId]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Order not found' });
    const orderNumber = result.rows[0].order_number;
    const fileName = `Order_Inward_${orderNumber}.pdf`;
    const filePath = path.join(dir, fileName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'PDF file not found. Please generate it first.' });
    }

    res.download(filePath, fileName);
  } catch (err) { next(err); }
});

// GET /api/pdf/preview/:type/:id - Preview PDF inline
router.get('/preview/:type/:id', async (req, res, next) => {
  try {
    const { type, id } = req.params;
    let filePath;

    if (type === 'inward') {
      const result = await query('SELECT * FROM inward_receipts WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT 1', [parseInt(id)]);
      if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Not found' });
      filePath = result.rows[0].pdf_path;
    } else if (type === 'invoice') {
      const result = await query('SELECT * FROM invoice_pdfs WHERE invoice_id = $1 ORDER BY created_at DESC LIMIT 1', [parseInt(id)]);
      if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Not found' });
      filePath = result.rows[0].pdf_path;
    } else if (type === 'order') {
      const oRes = await query('SELECT order_number FROM orders WHERE id = $1', [parseInt(id)]);
      if (oRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Order not found' });
      filePath = path.join(PDF_DIR, 'orders', `Order_Inward_${oRes.rows[0].order_number}.pdf`);
    } else {
      return res.status(400).json({ success: false, message: 'Invalid type' });
    }

    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'PDF file not found' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (err) { next(err); }
});

module.exports = router;
