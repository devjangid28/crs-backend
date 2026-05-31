# CRS Backend - Repair Management System API

PostgreSQL-powered REST API for the CRS Repair Management System.

## Tech Stack

- **Runtime:** Node.js 18+
- **Framework:** Express.js
- **Database:** PostgreSQL
- **Driver:** pg (node-postgres)

## Local Development

### Prerequisites

- Node.js 18+
- PostgreSQL 12+
- npm

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy environment file
cp .env.example .env

# 3. Edit .env with your PostgreSQL credentials
#    DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME

# 4. Create the database
createdb repair_management_system

# 5. Run schema migration
npm run migrate

# 6. Start the server
npm start
```

The API will be available at `http://localhost:5000`.

### Development Mode

```bash
npm run dev
```

Starts with `nodemon` for auto-restart on file changes.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET/POST | `/api/tickets` | List/Create tickets |
| GET/PUT/DELETE | `/api/tickets/:id` | Single ticket CRUD |
| PUT | `/api/tickets/:id/status` | Update ticket status |
| GET/POST | `/api/customers` | List/Create customers |
| GET/PUT/DELETE | `/api/customers/:id` | Single customer CRUD |
| GET | `/api/customers/:id/tickets` | Customer's tickets |
| GET/POST | `/api/invoices` | List/Create invoices |
| GET/PUT/DELETE | `/api/invoices/:id` | Single invoice CRUD |
| GET | `/api/dashboard/stats` | Dashboard statistics |
| GET | `/api/dashboard/chart-data` | Chart data |
| GET/POST | `/api/inventory` | List/Create inventory |
| GET/POST | `/api/appointments` | List/Create appointments |
| GET/POST/DELETE | `/api/notes` | Ticket notes CRUD |
| GET/POST/DELETE | `/api/attachments` | Ticket attachments CRUD |
| GET/POST | `/api/messages` | Messages CRUD |
| GET/PUT | `/api/settings` | Store settings |
| GET/POST | `/api/payments` | Payment history |

## Deployment on Render

### 1. Create a PostgreSQL Database on Render

- Go to **Dashboard → New → PostgreSQL**
- Name: `crs-db`
- Region: Choose closest to your users
- PostgreSQL Version: 16
- Note the **Internal Database URL**

### 2. Deploy the Web Service

- Go to **Dashboard → New → Web Service**
- Connect your GitHub repository
- **Root Directory:** (leave blank - the package.json is at root)
- **Runtime:** Node
- **Build Command:** `npm install`
- **Start Command:** `node src/server.js`
- **HTTP Port:** 5000 (Render maps 80/443 automatically)

### 3. Set Environment Variables in Render Dashboard

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | Internal Database URL from step 1 |
| `NODE_ENV` | `production` |
| `JWT_SECRET` | A strong random string |
| `CORS_ORIGIN` | Your frontend URL (or `*` for open) |

### 4. Deploy

Click **Create Web Service**. Render will build and deploy automatically.

### Health Check

After deployment, verify:

```
GET https://your-app.onrender.com/api/health
```

Expected response: `{ "status": "ok", "dbReady": true }`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Production | Full PostgreSQL connection string |
| `DB_HOST` | Local | PostgreSQL host |
| `DB_PORT` | Local | PostgreSQL port (default: 5432) |
| `DB_USER` | Local | PostgreSQL user |
| `DB_PASSWORD` | Local | PostgreSQL password |
| `DB_NAME` | Both | Database name (default: repair_management_system) |
| `PORT` | Both | API port (default: 5000) |
| `NODE_ENV` | Both | `development` or `production` |
| `JWT_SECRET` | Both | Secret key for auth tokens |
| `CORS_ORIGIN` | Both | Allowed CORS origin |
| `UPLOAD_DIR` | Both | File upload directory |

## Database

- **Name:** `repair_management_system`
- **Schema file:** `database_schema.pg.sql`
- **Migration command:** `npm run migrate`
- **SSL:** Enabled automatically in production

## Migration from MySQL

If you are migrating from an existing MySQL installation:

```bash
# 1. Ensure both MySQL and PostgreSQL are running
# 2. Run the data migration script
node src/migrations/migrate_data.js
```

## License

Private - CRS Software
