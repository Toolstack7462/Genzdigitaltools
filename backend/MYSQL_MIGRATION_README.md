# Gen Z Digital Store — MySQL/MariaDB Migration

This build has been migrated away from MongoDB/Mongoose runtime dependency.
The backend now uses `mysql2` with `DATABASE_URL` and a MySQL/MariaDB JSON-record adapter.

## Why this adapter was used

The existing codebase uses many Mongoose-style calls across admin, client, extension, security, and CRM routes. To preserve functionality and avoid breaking frontend/extension APIs, the migration keeps the public model API similar while storing data in MySQL/MariaDB tables.

Each model is stored in its own MySQL table:

- users
- tools
- tool_assignments
- device_bindings
- refresh_tokens
- extension_tokens
- activity_logs
- credential_access_logs
- blogs
- contacts
- expiry_dismissals
- notification_states
- security_alerts

Each table stores an `id`, JSON `data`, `createdAt`, and `updatedAt`.
This is the safest first migration for Hostinger MySQL hosting. A later optimization can normalize high-volume tables into strict relational columns.

## Required environment variable

```env
DATABASE_URL=mysql://user:password@host:3306/database_name
```

Hostinger example:

```env
DATABASE_URL=mysql://u123456789_genz:YOUR_PASSWORD@localhost:3306/u123456789_genz_crm
```

## Install and run

```bash
cd backend
npm install
cp .env.example .env
# edit DATABASE_URL and secrets
npm run seed:admin
npm start
```

## Important production notes

1. Use HTTPS for frontend/backend.
2. Keep `NODE_ENV=production` in production.
3. Use strong JWT secrets and a 64-hex `COOKIES_ENCRYPTION_KEY`.
4. Do not expose MySQL publicly unless necessary.
5. Enable Hostinger backups.
6. Run a full login/admin/client/extension test after deployment.

## Cross-check commands

```bash
cd backend
node --check server-crm.js
node --check db/mysqlAdapter.js
node --check routes/extension/index.js
node --check routes/authEnhanced.js
node --check scripts/seed-admin.js
```
