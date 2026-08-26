const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const config = require('./config/index');
const { pool, query, waitForPool } = require('./config/database');
const errorHandler = require('./middleware/errorHandler');

const ticketRoutes = require('./routes/tickets');
const staffTicketRoutes = require('./routes/staffTickets');
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
const storeRoutes = require('./routes/stores');
const testWhatsAppRoutes = require('./routes/testWhatsApp');
const whatsappWebhookRoutes = require('./routes/whatsappWebhook');
const amcRoutes = require('./routes/amc');
const amcPortalRoutes = require('./routes/amc_portal');
const tallyRoutes = require('./routes/tally');
const supplierRoutes = require('./routes/suppliers');
const demoModelRoutes = require('./routes/demoModels');
const notificationRoutes = require('./routes/notifications');
const quotationRoutes = require('./routes/quotation');
const notificationService = require('./services/notificationService');

const app = express();
const server = http.createServer(app);

// Socket.IO setup
const io = new Server(server, {
  cors: {
    origin: config.cors.origin,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

io.on('connection', (socket) => {
  console.log('Socket.IO client connected:', socket.id);

  socket.on('join_conversation', (conversationId) => {
    socket.join(`conv:${conversationId}`);
    console.log(`Socket ${socket.id} joined conversation: ${conversationId}`);
  });

  socket.on('leave_conversation', (conversationId) => {
    socket.leave(`conv:${conversationId}`);
  });

  socket.on('disconnect', () => {
    console.log('Socket.IO client disconnected:', socket.id);
  });
});

// Make io accessible to routes
app.set('io', io);

// Pass io to webhook
whatsappWebhookRoutes.setSocketIO(io);

// Make io accessible to all route handlers
app.use((req, res, next) => {
  req.io = io;
  next();
});

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
app.use('/api/staff/tickets', staffTicketRoutes);
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
app.use('/api/stores', storeRoutes);
app.use('/api', testWhatsAppRoutes);
app.use('/api/whatsapp', whatsappWebhookRoutes);
app.use('/api/amc', amcRoutes);
app.use('/api/amc', amcPortalRoutes);
app.use('/api/tally', tallyRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/demo-models', demoModelRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/quotations', quotationRoutes);

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

// Customer portal route — serve SPA so React can render CustomerAMCPortal
app.get('/amc/customer/:token', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(frontendDist, 'index.html'));
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
const tallyService = require('./services/tallyService');
(async () => {
  try {
    dbReady = await waitForPool(20, 500);
    if (dbReady) {
      console.log('Database connected successfully to ' + config.db.database);
      // Ensure the tally_sales table (customer purchase history from Tally) exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tally_sales (
          id SERIAL PRIMARY KEY,
          voucher_number TEXT,
          voucher_date DATE,
          party_name TEXT NOT NULL,
          party_ledger TEXT,
          party_phone TEXT,
          customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
          total_amount NUMERIC DEFAULT 0,
          items JSONB DEFAULT '[]',
          company_name TEXT,
          raw_data JSONB,
          synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (voucher_number, party_name)
        )`);
      await pool.query(`ALTER TABLE tally_sales ADD COLUMN IF NOT EXISTS party_phone TEXT`).catch(() => {});
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_tally_sales_customer ON tally_sales(customer_id)`).catch(() => {});
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_tally_sales_party ON tally_sales(party_name)`).catch(() => {});
      if (process.env.TALLY_HOST) {
        console.log('Starting Tally poller...');
        tallyService.startPoller(pool);
      }
      // Demo-model sellable check: notify owner once a demo unit's
      // 60-day lock period is over. Runs at startup + every 6 hours.
      notificationService.runSellableCheck(io).then(r =>
        console.log(`[Demo Check] Startup check -> ${JSON.stringify(r)}`)
      ).catch(e => console.error('[Demo Check] Startup error:', e.message));
      setInterval(() => {
        notificationService.runSellableCheck(io).then(r =>
          console.log(`[Demo Check] Scheduled check -> ${JSON.stringify(r)}`)
        ).catch(e => console.error('[Demo Check] Scheduled error:', e.message));
      }, 6 * 60 * 60 * 1000);
    }
  } catch (e) {
    console.warn('Database not available:', e.message);
  }
})();

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT} in ${config.server.env} mode`);
  console.log(`API available at http://localhost:${PORT}/api`);
  console.log(`Socket.IO available on same port`);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err.message);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});

module.exports = { app, server, io };