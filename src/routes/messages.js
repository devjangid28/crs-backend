const express = require('express');
const router = express.Router();
const { query } = require('../config/database');

router.get('/', async (req, res, next) => {
  try {
    const { conversationId } = req.query;
    let sql = 'SELECT * FROM messages WHERE 1=1';
    const params = [];
    if (conversationId) { sql += ' AND conversation_id = ?'; params.push(conversationId); }
    sql += ' ORDER BY created_at ASC';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { conversationId, sender, receiver, subject, body } = req.body;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const convId = conversationId || `CONV-${Date.now()}`;
    const result = await query(
      `INSERT INTO messages (conversation_id, sender, receiver, subject, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      [convId, sender || '', receiver || '', subject || '', body || '', now]
    );
    const insertId = result.rows[0].id;
    const msgResult = await query('SELECT * FROM messages WHERE id = ?', [insertId]);
    res.status(201).json({ success: true, data: msgResult.rows[0] });
  } catch (err) { next(err); }
});

router.get('/conversations', async (req, res, next) => {
  try {
    const sql = `SELECT conversation_id, MAX(created_at) as last_message, COUNT(*) as message_count
                 FROM messages GROUP BY conversation_id ORDER BY last_message DESC`;
    const conversations = await query(sql);
    res.json({ success: true, data: conversations.rows });
  } catch (err) { next(err); }
});

module.exports = router;
