# Deployment Checklist — Gen Z Digital Store

## Environment Variables (Hostinger Node.js)

Set these in the Hostinger control panel under **Node.js → Environment variables**.
Never commit real values to git.

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | Yes | `production` |
| `JWT_SECRET` | Yes | Min 32 chars, random |
| `JWT_REFRESH_SECRET` | Yes | Min 32 chars, different from JWT_SECRET |
| `COOKIES_ENCRYPTION_KEY` | Yes | Exactly 64 hex chars. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DATABASE_URL` | Yes | Full MySQL/MariaDB connection string |
| `ALLOWED_ORIGINS` | Yes | Comma-separated: `https://app.genzdigitalstore.com,https://genzdigitalstore.com` |
| `INITIAL_ADMIN_EMAIL` | Yes | Bootstrap admin email |
| `INITIAL_ADMIN_PASSWORD` | Yes | Min 12 chars — change after first login |
| `INITIAL_ADMIN_NAME` | No | Defaults to "Super Admin" |
| `DASHBOARD_SESSION_DAYS` | No | Refresh token lifetime in days (default 30) |
| `CRM_PORT` | No | Backend port (default 8002) |
| `REACT_APP_BACKEND_URL` | Yes | Frontend build-time var: `https://api.genzdigitalstore.com` (no trailing slash) |

## Backend Deployment Steps

1. Upload `backend/` to Hostinger Node.js app directory.
2. Run `npm install --omit=dev` in the backend directory.
3. Set all environment variables above.
4. Start with PM2: `pm2 start server-crm.js --name genz-crm`.
5. Verify: `GET https://api.genzdigitalstore.com/api/crm/health` returns `{"status":"ok"}`.

## Frontend Deployment Steps

1. Set `REACT_APP_BACKEND_URL=https://api.genzdigitalstore.com` in the build environment.
2. Run `npm install --legacy-peer-deps && npm run build` inside `frontend/`.
3. Upload `frontend/build/` to Hostinger static hosting root.
4. Ensure the web server serves `index.html` for all non-asset routes (SPA fallback).
5. Ensure `frontend/public/downloads/genz-digital-store-extension.zip` is accessible at `/downloads/genz-digital-store-extension.zip`.

## Database Setup

1. Create MySQL/MariaDB database.
2. Ensure the `DATABASE_URL` user has `CREATE`, `ALTER`, `INDEX`, `INSERT`, `UPDATE`, `DELETE`, `SELECT` privileges.
3. Tables are auto-created on first boot via `mysqlAdapter.ensureTables()`.

## Chrome Extension Deployment

1. Build extension ZIP from `chrome-extension/` directory (see `EXTENSION_INSTALL_GUIDE.md`).
2. Upload ZIP to `frontend/public/downloads/genz-digital-store-extension.zip`.
3. Optionally publish to Chrome Web Store — update `externally_connectable` in `manifest.json` with the published extension ID.

## Post-Deploy Verification

- [ ] `GET /api/crm/health` → `status: ok`
- [ ] Admin login at `/admin/login` succeeds
- [ ] Admin dashboard loads without crash
- [ ] Create a test client account
- [ ] Assign a tool to the test client
- [ ] Client login succeeds
- [ ] Client dashboard shows assigned tool
- [ ] Extension installs from `/chrome-extension` download link
- [ ] Extension auto-connects on client dashboard
- [ ] Access button opens the tool with a fresh authorized session
- [ ] Extension popup shows "Managed by admin" for access policy
- [ ] Logout clears session cookies
