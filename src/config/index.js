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
  neon: {
    apiKey: process.env.NEON_API_KEY || null,
    orgId: process.env.NEON_ORG_ID || null,
    region: process.env.NEON_REGION || null,
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
    templateServiceInvoice: process.env.WHATSAPP_TEMPLATE_SERVICE_INVOICE || 'service_invoice',
    templateOrderInvoice: process.env.WHATSAPP_TEMPLATE_ORDER_INVOICE || 'order_invoice',
    templateReview: process.env.WHATSAPP_TEMPLATE_REVIEW || 'review_link',
    templateBookingChallan: process.env.WHATSAPP_TEMPLATE_BOOKING_CHALLAN || 'booking_challan',
    // Image-header template used to deliver repair photos to the customer.
    // Free-form image sends are rejected by Meta outside the 24h service window
    // ("Re-engagement message"), so this template is the only way an image
    // actually reaches the customer. Requires an IMAGE header in Meta.
    templateImageUpdate: process.env.WHATSAPP_TEMPLATE_IMAGE_UPDATE || 'repair_photo',
    // Utility template used to deliver a merged "photo sheet" (a single grid
    // image built from several repair photos). Same reasoning as
    // templateImageUpdate: Meta will not deliver free-form images outside the
    // 24h window, so this template is the only reliable route. Requires an
    // IMAGE header in Meta.
    templatePhotoSheet: process.env.WHATSAPP_TEMPLATE_PHOTO_SHEET || 'repair_photo_update',
    // Body variables for the image template, comma separated. Meta rejects a send
    // whose parameter count does not match the approved template body, so this
    // must be set to exactly the number of {{n}} placeholders in the template.
    // Empty means the approved template body has no variables.
    templateImageUpdateParams: (process.env.WHATSAPP_TEMPLATE_IMAGE_UPDATE_PARAMS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
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
      'service_invoice': 'en_IN',
      'order_invoice': 'en_IN',
      'review_link': 'en_IN',
      'booking_challan': process.env.WHATSAPP_TEMPLATE_BOOKING_CHALLAN_LANG || 'en_IN',
      'repair_photo': process.env.WHATSAPP_TEMPLATE_IMAGE_UPDATE_LANG || 'en_IN',
      // NOTE: the language is resolved by exact template name. Without an entry
      // here a renamed template silently falls back to en_GB at send time and
      // Meta rejects it with "template does not exist" for the approved en_IN
      // language, so keep this key in sync with WHATSAPP_TEMPLATE_PHOTO_SHEET.
      'repair_photo_update': process.env.WHATSAPP_TEMPLATE_PHOTO_SHEET_LANG || 'en_IN',
    }),
  },
};

module.exports = config;
