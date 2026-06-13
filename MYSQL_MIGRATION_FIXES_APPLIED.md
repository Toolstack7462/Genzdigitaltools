# MySQL/MariaDB Migration Fixes Applied

## Base
This ZIP was converted from the fixed Gen Z Digital Store security/extension build.

## What was migrated

- Removed MongoDB/Mongoose runtime dependency from the backend.
- Added MySQL/MariaDB persistence through `backend/db/mysqlAdapter.js`.
- Updated backend startup to use `DATABASE_URL` instead of `MONGO_URL`.
- Updated `.env.example` for Hostinger MySQL/MariaDB deployment.
- Updated backend `package.json` to use `mysql2`.
- Replaced all backend model files with MySQL-backed model wrappers while preserving the Mongoose-style API used by the existing routes.
- Updated admin seed script for MySQL/MariaDB.
- Updated health endpoint to show MySQL connection status.
- Added `backend/MYSQL_MIGRATION_README.md`.

## Preserved functionality targets

The model API was preserved so these flows continue to use the same frontend and extension contracts:

- Admin login/logout
- Client login/logout
- Device binding
- Admin device reset
- Client force logout
- Extension activation/pairing
- Extension token verification
- Dashboard Access button → extension bridge → tool open
- Tool assignment and expiry checks
- Session bundle and direct-open support
- Security alerts and risky extension scanner metadata
- Blog/contact/admin/client routes

## Important implementation note

The migration uses one MySQL table per model with a JSON payload column. This is the safest compatibility-first migration for the current codebase because the existing API uses many Mongoose-style patterns. It is suitable for initial Hostinger MySQL hosting. Later, high-volume reporting tables can be normalized into strict relational columns if the system grows.

## Required environment

```env
DATABASE_URL=mysql://user:password@localhost:3306/database_name
```

## Cross-check performed

Passed:

```bash
find backend -type f -name '*.js' -not -path '*/node_modules/*' -print0 | xargs -0 -n1 node --check
find chrome-extension/js -type f -name '*.js' -print0 | xargs -0 -n1 node --check
```

Limitations:

- Runtime DB connection was not executed here because no live MySQL server credentials were available in the sandbox.
- Full frontend production build requires local/server `npm install` in `frontend`.
- Run a live staging test after setting Hostinger `DATABASE_URL`.

## Deployment steps

1. Create MySQL/MariaDB database in Hostinger.
2. Copy `backend/.env.example` to `backend/.env`.
3. Set `DATABASE_URL` and all secrets.
4. Run:

```bash
cd backend
npm install
npm run seed:admin
npm start
```

5. Build frontend with correct API URL and extension ID.
6. Test admin, client, device binding, extension pairing, dashboard Access button, and force logout.
