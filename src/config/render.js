/**
 * Render PostgreSQL Deployment Configuration
 * 
 * This file documents the configuration needed for deploying
 * to Render with PostgreSQL.
 * 
 * ============================================================
 * RENDER DEPLOYMENT SETUP
 * ============================================================
 * 
 * 1. RENDER POSTGRESQL SETUP:
 *    - Create a PostgreSQL database on Render (e.g., "crs-db")
 *    - Note the "Internal Database URL" or "External Database URL"
 * 
 * 2. RENDER WEB SERVICE SETUP:
 *    - Create a Web Service pointing to your repository
 *    - Root Directory: server/
 *    - Build Command: npm install
 *    - Start Command: node src/server.js
 *    - HTTP Port: 5000 (internal, Render maps to 80/443)
 * 
 * 3. ENVIRONMENT VARIABLES (in Render dashboard):
 *    - Key: DATABASE_URL
 *      Value: postgresql://user:password@host:5432/repair_management_system
 *      (Use the Internal Database URL from Render PostgreSQL)
 *    
 *    - Key: NODE_ENV
 *      Value: production
 *    
 *    - Key: JWT_SECRET
 *      Value: <your-production-secret>
 *    
 *    - Key: CORS_ORIGIN
 *      Value: https://your-frontend-domain.com
 * 
 * 4. SSL CONFIGURATION:
 *    The database.js config automatically handles SSL:
 *      - In production (NODE_ENV=production): SSL enabled with rejectUnauthorized: false
 *      - In development: SSL disabled
 * 
 * ============================================================
 * LOCAL DEVELOPMENT WITH POSTGRESQL
 * ============================================================
 * 
 * Option A: Local PostgreSQL
 *   - Install PostgreSQL locally
 *   - Create database: CREATE DATABASE repair_management_system;
 *   - Run schema: psql -d repair_management_system -f database_schema.pg.sql
 *   - Configure server/.env with local PostgreSQL connection
 * 
 * Option B: Render PostgreSQL (remote)
 *   - Copy the External Database URL from Render
 *   - Set in server/.env: DATABASE_URL=<external-url>
 *   - Set NODE_ENV=development (SSL handled automatically)
 * 
 * ============================================================
 * INITIAL SETUP COMMANDS
 * ============================================================
 * 
 * # Create the database
 * createdb repair_management_system
 * 
 * # Run the schema
 * psql -d repair_management_system -f database_schema.pg.sql
 * 
 * # Or use the migration script
 * cd server && npm run migrate
 * 
 * # Start the server
 * cd server && npm start
 * 
 * ============================================================
 * TROUBLESHOOTING
 * ============================================================
 * 
 * - "ECONNREFUSED": PostgreSQL not running or wrong host/port
 * - "does not exist": Database not created
 * - "role does not exist": User not created or wrong credentials
 * - "self-signed certificate": SSL issue - check NODE_ENV
 * - "permission denied": Check pg_hba.conf settings
 */

module.exports = {
  description: 'Render PostgreSQL deployment configuration',
  version: '1.0.0',
};
