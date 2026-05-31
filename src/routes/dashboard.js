const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { getRecentActivity } = require('../services/statusHistoryService');

// GET /api/dashboard/stats - Get dashboard statistics
router.get('/stats', async (req, res, next) => {
  try {
    const totalTickets = await query('SELECT COUNT(*) as count FROM tickets');
    const statusCounts = await query(
      `SELECT status, COUNT(*) as count FROM tickets GROUP BY status`
    );

    const today = new Date().toISOString().slice(0, 10);
    const newToday = await query(
      'SELECT COUNT(*) as count FROM tickets WHERE DATE(created_at) = ?', [today]
    );
    const completedToday = await query(
      'SELECT COUNT(*) as count FROM tickets WHERE status IN (?, ?) AND DATE(updated_at) = ?', ['Completed', 'Delivered', today]
    );

    const statusMap = {};
    statusCounts.rows.forEach(row => { statusMap[row.status] = parseInt(row.count); });

    const total = parseInt(totalTickets.rows[0]?.count) || 0;

    res.json({
      success: true,
      data: {
        totalTickets: total,
        newToday: parseInt(newToday.rows[0]?.count) || 0,
        completedToday: parseInt(completedToday.rows[0]?.count) || 0,
        new: statusMap['New'] || 0,
        pending: statusMap['Pending'] || 0,
        inProgress: statusMap['In Progress'] || 0,
        waitingForParts: statusMap['Waiting For Parts'] || 0,
        completed: (statusMap['Completed'] || 0) + (statusMap['Delivered'] || 0),
        delivered: statusMap['Delivered'] || 0,
        cancelled: statusMap['Cancelled'] || 0,
        awaitingParts: statusMap['Awaiting Parts'] || 0,
        awaitingPayment: statusMap['Awaiting Payment'] || 0,
        openTickets: total - (statusMap['Completed'] || 0) - (statusMap['Delivered'] || 0) - (statusMap['Cancelled'] || 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/recent-tickets - Get recent tickets
router.get('/recent-tickets', async (req, res, next) => {
  try {
    const tickets = await query(
      'SELECT id, customer_name, status, priority, created_at, device_type FROM tickets ORDER BY created_at DESC LIMIT 10'
    );
    res.json({ success: true, data: tickets.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/recent-activity - Get recent status changes
router.get('/recent-activity', async (req, res, next) => {
  try {
    const activity = await getRecentActivity(15);
    res.json({ success: true, data: activity });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/chart-data - Get weekly chart data
router.get('/chart-data', async (req, res, next) => {
  try {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().slice(0, 10);
      days.push(dateStr);
    }

    const chartData = [];
    for (const day of days) {
      const newCount = await query('SELECT COUNT(*) as count FROM tickets WHERE DATE(created_at) = ?', [day]);
      const completedCount = await query(
        'SELECT COUNT(*) as count FROM tickets WHERE status IN (?, ?) AND DATE(updated_at) = ?', ['Completed', 'Delivered', day]
      );
      const inProgressCount = await query(
        'SELECT COUNT(*) as count FROM tickets WHERE status = ? AND DATE(created_at) <= ? AND (DATE(updated_at) >= ? OR updated_at IS NULL)', ['In Progress', day, day]
      );

      const dayLabel = ['M', 'T', 'W', 'T', 'F', 'S', 'S'][new Date(day).getDay() === 0 ? 6 : new Date(day).getDay() - 1] || 'M';
      chartData.push({
        day: dayLabel,
        today: parseInt(newCount.rows[0]?.count) || 0,
        week: parseInt(completedCount.rows[0]?.count) || 0,
        month: parseInt(inProgressCount.rows[0]?.count) || 0,
      });
    }

    res.json({ success: true, data: chartData });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
