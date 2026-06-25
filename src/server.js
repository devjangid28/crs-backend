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
const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const pdfRoutes = require('./routes/pdf');
const publicRoutes = require('./routes/public');
const orderRoutes = require('./routes/orders');
const testWhatsAppRoutes = require('./routes/testWhatsApp');

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
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/pdf', pdfRoutes);
app.use('/api', publicRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api', testWhatsAppRoutes);

// ---- Serve built frontend as static files ----
const frontendDist = path.join(__dirname, '..', '..', 'dist');
app.use(express.static(frontendDist, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (/\.(js|css|svg|png|jpg|jpeg|gif|ico|woff2?|ttf|eot)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, immutable, max-age=31536000');
    }
  }
}));

// Serve public/ directory for customer-facing pages
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// Customer-facing routes (server-rendered pages)
const publicDir = path.join(__dirname, '..', 'public');
app.get('/track/:ticketId/:token', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(publicDir, 'tracking.html'));
});
app.get('/collect/:ticketId/:token', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(publicDir, 'collection.html'));
});
app.get('/feedback/:ticketId/:token', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(publicDir, 'feedback.html'));
});

// SPA fallback: serve index.html for all non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return;
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(frontendDist, 'index.html'));
});

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
