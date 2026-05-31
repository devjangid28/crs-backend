const express = require('express');
const router = express.Router();
const { query } = require('../config/database');

router.get('/', async (req, res, next) => {
  try {
    const { date, technician } = req.query;
    let sql = 'SELECT * FROM appointments WHERE 1=1';
    const params = [];
    if (date) { sql += ' AND date = ?'; params.push(date); }
    if (technician) { sql += ' AND technician = ?'; params.push(technician); }
    sql += ' ORDER BY date ASC, start_time ASC';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { ticketId, customerId, customerName, title, description, appointmentDate, date, startTime, start_time, endTime, end_time, type, status, technician, location, priority, notes } = req.body;
    const resolvedDate = appointmentDate || date;
    if (!resolvedDate) {
      return res.status(400).json({ success: false, message: 'Appointment date is required' });
    }
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const result = await query(
      `INSERT INTO appointments (ticket_id, customer_id, customer_name, title, description, date, start_time, end_time, type, priority, status, technician, location, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [ticketId || null, customerId || null, customerName || '', title || '', description || '', resolvedDate, startTime || start_time || null, endTime || end_time || null, type || 'In-Store Drop-off', priority || null, status || 'Scheduled', technician || '', location || 'Repair Shop', notes || null, now, now]
    );
    const insertId = result.rows[0].id;
    const apptResult = await query('SELECT * FROM appointments WHERE id = ?', [insertId]);
    res.status(201).json({ success: true, data: apptResult.rows[0] });
  } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const updates = req.body;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const mapping = { title: 'title', description: 'description', appointmentDate: 'date', date: 'date', startTime: 'start_time', start_time: 'start_time', endTime: 'end_time', end_time: 'end_time', type: 'type', priority: 'priority', status: 'status', technician: 'technician', location: 'location', notes: 'notes' };
    const setClauses = ['updated_at = ?'];
    const values = [now];
    const seenCols = new Set(['updated_at']);
    for (const [front, db] of Object.entries(mapping)) {
      if (updates[front] !== undefined && !seenCols.has(db)) { seenCols.add(db); setClauses.push(`${db} = ?`); values.push(updates[front]); }
    }
    values.push(req.params.id);
    await query(`UPDATE appointments SET ${setClauses.join(', ')} WHERE id = ?`, values);
    const apptResult = await query('SELECT * FROM appointments WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: apptResult.rows[0] });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await query('DELETE FROM appointments WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Appointment deleted' });
  } catch (err) { next(err); }
});

module.exports = router;
