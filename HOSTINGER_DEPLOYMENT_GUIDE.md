# Hostinger Deployment Guide — Gen Z Digital Store

This guide is for Hostinger **Node.js App Hosting + Managed MySQL/MariaDB**.

## 1. Before upload

Make sure your Hostinger plan includes:

- Managed Node.js web apps
- Managed MySQL/MariaDB database
- Environment variables
- SSL certificate
- Custom domain/subdomain
- GitHub or file upload deployment

Recommended domains:

- Frontend: `https://genzdigitalstore.com`
- Backend/API: `https://api.genzdigitalstore.com`
- Optional app dashboard: `https://app.genzdigitalstore.com`

## 2. Create MySQL database in Hostinger

Create a MySQL database from Hostinger hPanel.

Save these values:

- Database name
- Database username
- Database password
- Database host, usually `localhost` on Hostinger managed hosting

Your backend `.env` should contain:

```env
DATABASE_URL=mysql://DB_USER:DB_PASSWORD@localhost:3306/DB_NAME
```

Example:

```env
DATABASE_URL=mysql://u123456789_genz:YOUR_PASSWORD@localhost:3306/u123456789_genz_store
```

## 3. Backend environment variables

Go to Hostinger Node.js app settings and add environment variables similar to:

```env
NODE_ENV=production
PORT=5000
DATABASE_URL=mysql://DB_USER:DB_PASSWORD@localhost:3306/DB_NAME

FRONTEND_URL=https://genzdigitalstore.com
CLIENT_URL=https://genzdigitalstore.com
API_BASE_URL=https://api.genzdigitalstore.com/api/crm

JWT_ACCESS_SECRET=CHANGE_TO_64_PLUS_RANDOM_HEX_CHARS
JWT_REFRESH_SECRET=CHANGE_TO_64_PLUS_RANDOM_HEX_CHARS
COOKIE_SECRET=CHANGE_TO_64_PLUS_RANDOM_HEX_CHARS
CREDENTIAL_ENCRYPTION_KEY=CHANGE_TO_64_PLUS_RANDOM_HEX_CHARS

CORS_ORIGIN=https://genzdigitalstore.com,https://app.genzdigitalstore.com
```

Use strong random secrets. Do not use the sample values in production.

## 4. Upload backend

Upload the `backend/` folder as your Node.js app.

Run/install command:

```bash
npm install
```

Start command:

```bash
npm start
```

If your package uses a different start command, check `backend/package.json`.

## 5. Seed first admin

After backend dependencies are installed and `.env` is set:

```bash
npm run seed:admin
```

If the seed script asks for values, create your first admin account.

## 6. Frontend build

On your computer or Hostinger build terminal:

```bash
cd frontend
npm install --legacy-peer-deps
npm run build
```

Upload the generated `frontend/build/` contents to your frontend domain public directory.

If Hostinger deploys React automatically, set build command:

```bash
npm install --legacy-peer-deps && npm run build
```

Build output directory:

```text
build
```

## 7. Update frontend API URL

Before building frontend, set:

```env
REACT_APP_API_URL=https://api.genzdigitalstore.com/api/crm
REACT_APP_EXTENSION_ID=YOUR_CHROME_EXTENSION_ID
```

The extension ID is available after loading/publishing the Chrome extension.

## 8. Chrome extension setup

Use the folder:

```text
chrome-extension/
```

For local testing:

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable Developer Mode.
4. Click **Load unpacked**.
5. Select the `chrome-extension` folder.
6. Copy the extension ID.
7. Put that ID into `REACT_APP_EXTENSION_ID` and rebuild frontend.

For production:

- Publish to Chrome Web Store or provide manual installation instructions.
- Keep privacy policy updated because the extension uses site access and security scanner features.

## 9. SSL/HTTPS

HTTPS is required in production because Secure HttpOnly cookies will not work reliably on plain HTTP.

Make sure both are HTTPS:

- `https://genzdigitalstore.com`
- `https://api.genzdigitalstore.com`

## 10. Final smoke test

Test in this order:

1. Backend health endpoint.
2. Admin login.
3. Create client.
4. Client login.
5. Device binding.
6. Add tool in admin.
7. Assign tool to client.
8. Install extension.
9. Pair extension from client dashboard.
10. Click Access on a tool card.
11. Permission prompt/allow flow.
12. Direct-open tool.
13. Session-bundle tool.
14. Client force logout.
15. Extension token revoked state.
16. Admin device reset.

## 11. Important production notes

- Do not expose `.env` files publicly.
- Keep database backups enabled.
- Use strong passwords and secrets.
- Keep Chrome extension permissions documented.
- Test all tool access methods before giving clients access.
