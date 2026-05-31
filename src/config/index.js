require('dotenv').config();

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
};

module.exports = config;
