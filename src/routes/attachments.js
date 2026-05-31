const express = require('express');
const router = express.Router();
const { query } = require('../config/database');

router.get('/', async (req, res, next) => {
  try {
    const { ticketId } = req.query;
    let sql = 'SELECT * FROM attachments WHERE 1=1';
    const params = [];
    if (ticketId) { sql += ' AND ticket_id = ?'; params.push(ticketId); }
    sql += ' ORDER BY created_at DESC';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { ticketId, fileName, fileSize, fileType, filePath } = req.body;
    const result = await query(
      `INSERT INTO attachments (ticket_id, name, file_size, file_type, file_path) VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [ticketId || null, fileName, fileSize || 0, fileType || '', filePath || '']
    );
    const insertId = result.rows[0].id;
    const attResult = await query('SELECT * FROM attachments WHERE id = ?', [insertId]);
    res.status(201).json({ success: true, data: attResult.rows[0] });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await query('DELETE FROM attachments WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Attachment deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
