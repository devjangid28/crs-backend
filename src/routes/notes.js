const express = require('express');
const router = express.Router();
const { query } = require('../config/database');

router.get('/', async (req, res, next) => {
  try {
    const { ticketId } = req.query;
    let sql = 'SELECT * FROM notes WHERE 1=1';
    const params = [];
    if (ticketId) { sql += ' AND ticket_id = ?'; params.push(ticketId); }
    sql += ' ORDER BY created_at DESC';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { ticketId, text, author, noteType } = req.body;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const result = await query(
      `INSERT INTO notes (ticket_id, text, author, type, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [ticketId || null, text, author || 'Current User', noteType || 'customer', now]
    );
    const insertId = result.rows[0].id;
    const noteResult = await query('SELECT * FROM notes WHERE id = ?', [insertId]);
    res.status(201).json({ success: true, data: noteResult.rows[0] });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await query('DELETE FROM notes WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Note deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
