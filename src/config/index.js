const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const config = {
  db: {
    databaseUrl: process.env.DATABASE_URL || null,
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'repair_management_system',
    waitForConnections: true,
    connectionLimit: 10,
  },
  server: {
    port: parseInt(process.env.PORT, 10) || 5000,
    env: process.env.NODE_ENV || 'development',
    publicUrl: process.env.PUBLIC_URL || null,
  },
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
  },
  jwt: {
    secret: process.env.JWT_SECRET,
  },
  upload: {
    dir: process.env.UPLOAD_DIR || './uploads',
  },
  whatsapp: {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
    enabled: process.env.WHATSAPP_ENABLED === 'true',
    templateName: process.env.WHATSAPP_TEMPLATE_NAME || 'ticket_created',
    orderTemplateName: process.env.WHATSAPP_ORDER_TEMPLATE_NAME || 'order_created',
    templatePending: process.env.WHATSAPP_TEMPLATE_PENDING || 'ticket_pending',
    templateInProgress: process.env.WHATSAPP_TEMPLATE_IN_PROGRESS || 'ticket_in_progress',
    templatePartiallyCompleted: process.env.WHATSAPP_TEMPLATE_PARTIAL_COMPLETED || 'ticket_partially_completed',
    templateReadyForPickup: process.env.WHATSAPP_TEMPLATE_READY_FOR_PICKUP || 'ticket_ready_for_pickup',
    templateCompleted: process.env.WHATSAPP_TEMPLATE_COMPLETED || 'ticket_completed',
    templateCancelled: process.env.WHATSAPP_TEMPLATE_CANCELLED || 'ticket_cancelled',
    templateCollection: process.env.WHATSAPP_TEMPLATE_COLLECTION || 'device_collection',
    templateInward: process.env.WHATSAPP_TEMPLATE_INWARD || 'inward_receipt',
    templateLanguages: Object.freeze({
      'ticket_created': 'en_GB',
      'ticket_pending': 'en_GB',
      'ticket_completed': 'en_GB',
      'ticket_cancelled': 'en',
      'ticket_in_progress': 'en',
      'ticket_partially_completed': 'en_IN',
      'ticket_ready_for_pickup': 'en_IN',
      'order_created': 'en_GB',
      'device_collection': 'en_IN',
      'inward_receipt': 'en_IN',
    }),
  },
};

module.exports = config;
