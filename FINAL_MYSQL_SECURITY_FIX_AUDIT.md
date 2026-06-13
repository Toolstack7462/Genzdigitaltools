# Final MySQL + Extension Security Fix Audit

This build applies the senior full-stack/security fixes requested after the MySQL migration audit.

## Fixed in this build

### MySQL compatibility adapter
- Added `distinct(field, criteria)` support for admin device filters.
- Added `$nin` query operator support.
- Fixed `findOne().sort()` so latest activation/intent-style queries behave correctly.
- Added aggregation expression support for `$cond` and `$eq`, used by admin assignment stats.
- Added MySQL JSON-table mappings for `open_intents` and `activation_tokens`.

### Dedicated security token models
- Added `backend/models/OpenIntent.js`.
- Added `backend/models/ActivationToken.js`.
- Dashboard open-intent tokens are now stored in `open_intents`, not `ActivityLog`.
- Extension activation tokens are now stored in `activation_tokens`, not `ActivityLog`.
- Activation tokens are consumed once.
- Open-intent tokens are consumed once during extension verification.

### Extension device binding
- Extension API requests now send `X-Device-Id-Hash`.
- Backend verifies that the request device hash matches the `ExtensionToken.deviceIdHash`.
- Copied extension tokens from another device are rejected and revoked.

### Client dashboard → extension tool opening
- Dashboard still creates intent via `/api/crm/client/tools/:toolId/open-intent`.
- Extension verifies intent via `/api/crm/extension/verify-intent`.
- Extension refreshes its cached tool list if a tool is not found locally.
- Direct-open fallback is preserved for tools without credentials/session bundles.
- Session-bundle-only support is preserved.

### Permission flow
- Added `GENZ_REQUEST_PERMISSION` bridge message.
- Dashboard can request missing host permission through the installed extension and retry once with a fresh intent token.
- Extension permission checks use origin patterns instead of raw URLs.

### Existing preserved behavior
- Admin logout does not affect clients.
- Client force logout revokes refresh tokens and extension tokens.
- Admin device reset revokes extension tokens.
- Security scanner remains consent-based and does not claim cookies were copied.

## Cross-checks run

Passed:

```bash
find backend -type f -name '*.js' -not -path '*/node_modules/*' -print0 | xargs -0 -n1 node --check
find chrome-extension/js -type f -name '*.js' -print0 | xargs -0 -n1 node --check
node --check frontend/src/hooks/useExtension.js
```

Not run in this sandbox:

- Frontend production build, because `node_modules` are not installed in the sandbox.
- Live MySQL connection test, because no Hostinger `DATABASE_URL` credentials were provided.
- Real Chrome extension runtime test, because browser extension execution is outside this environment.

## Deployment checks still required on server

```bash
cd backend
npm install
npm run check
npm run seed:admin
npm start
```

```bash
cd frontend
npm install --legacy-peer-deps
npm run build
```

Then test in Chrome:

1. Client login.
2. Device binding.
3. Extension detection.
4. Extension pairing from dashboard.
5. Dashboard Access button.
6. Permission missing/grant flow.
7. Direct-open tool.
8. Session-bundle tool.
9. Client force logout.
10. Admin device reset.
11. Extension revoked state.
