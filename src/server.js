const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config/index');
const { pool, query, waitForPool } = require('./config/database');
const errorHandler = require('./middleware/errorHandler');

const ticketRoutes = require('./routes/tickets');
const customerRoutes = require('./routes/customers');
const invoiceRoutes = require('./routes/invoices');
const dashboardRoutes = require('./routes/dashboard');
const inventoryRoutes = require('./routes/inventory');
const appointmentRoutes = require('./routes/appointments');
const noteRoutes = require('./routes/notes');
const attachmentRoutes = require('./routes/attachments');
const messageRoutes = require('./routes/messages');
const settingsRoutes = require('./routes/settings');
const paymentRoutes = require('./routes/payments');

const app = express();

app.use(cors({ origin: config.cors.origin, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// Health endpoint includes DB status
let dbReady = false;
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', dbReady, timestamp: new Date().toISOString(), uptime: process.uptime() });
});

app.use('/api/tickets', ticketRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/attachments', attachmentRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/payments', paymentRoutes);

app.use(errorHandler);

const PORT = config.server.port;

// ---- Try to connect to DB on startup (non-blocking) ----
(async () => {
  try {
    dbReady = await waitForPool(20, 500);
    if (dbReady) {
      console.log('Database connected successfully to ' + config.db.database);
    }
  } catch (e) {
    console.warn('Database not available:', e.message);
  }
})();

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} in ${config.server.env} mode`);
  console.log(`API available at http://localhost:${PORT}/api`);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err.message);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});

module.exports = server;
