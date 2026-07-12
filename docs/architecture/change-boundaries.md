# Change Boundaries (As-Built)

> Strict maintenance boundaries so a single issue changes only its component. Paths are
> verified against the current code. **A fix must stay inside the boundary for its issue
> type unless the verified root cause proves otherwise.**

---

## Prime directive

**Future fixes must be surgical. Do not modify unrelated modules, security controls,
authentication flows, API contracts, database behaviour, deployment settings, or UI
components unless the verified root cause requires it. A single issue must not trigger a
broad refactor.**

---

## 1. Frontend display / UI issues

Change **only**:
- The specific page under `frontend/src/pages/**` (admin / client / public) that renders wrong.
- Its local components under `frontend/src/components/**` (including `ui/` primitives **only**
  if the defect is truly in the primitive — otherwise fix the page).
- Styling: `frontend/src/App.css`, `frontend/src/index.css`, `frontend/src/styles/**`,
  `frontend/tailwind.config.js`, `frontend/postcss.config.js`.
- Layout wrappers `AdminLayoutEnhanced.js` / `ClientLayoutEnhanced.js` **only** when the
  defect is in the shared shell (nav/sidebar/footer), and then regression-test both panels.
- SEO/meta: `frontend/src/RouteSeo.js`, `frontend/src/seoConfig.js`.

Do **not** touch for a display-only bug: `services/api.js`, `services/authService.js`,
`services/authDiagnostics.js`, `App.js` route/guard wiring, or any backend file.

## 2. API connectivity issues (calls failing, wrong base URL, 404, CORS)

Change **only** (start at the layer the evidence points to):
- Base URL / interceptor / refresh: `frontend/src/services/api.js`.
- Which env the base URL reads: `frontend/.env.production` (`REACT_APP_BACKEND_URL`) — a
  config value, not code.
- The feature service wrapper: `frontend/src/services/{assignments,tools,stealth,proxyTools,writeHumanV2}Service.js`.
- Server-side CORS allowlist: `backend/server-crm.js` (the `corsOptions`/`FIRST_PARTY_ORIGINS`
  block, `server-crm.js:66-141`) — and prefer changing the `ALLOWED_ORIGINS` **env** over code.
- Route existence / mount path: `backend/server-crm.js` route mounts (`:271-354`) and the
  specific `backend/routes/**` file.
- Reverse-proxy routing (a path 404s at the web server, not Node): `frontend/app.htaccess`
  and `frontend/public/.htaccess`.

Do **not** touch auth/token logic or the database for a pure connectivity bug.

## 3. Authentication issues (login, refresh, logout, roles, device)

Change **only** the file that owns the failing stage:
- Login / refresh / logout / register / `*/me` handlers: `backend/routes/authEnhanced.js`.
- Token sign/verify, cookie flags, role gates, `requireAuth*`: `backend/middleware/authEnhanced.js`.
- Email verification / password reset: `backend/routes/authEmail.js`.
- Input validation of auth payloads: `backend/middleware/validation.js` (schemas) +
  `backend/middleware/normalize.js`.
- Rate-limit lockouts: `backend/middleware/rateLimiter.js`.
- Identity/role model: `backend/models/User.js`; session store: `backend/models/RefreshToken.js`.
- Device policy: `backend/models/DeviceProfile.js` (gate) + `backend/models/DeviceBinding.js`
  (legacy sync).
- Frontend session lifecycle: `frontend/src/services/authService.js`; refresh interceptor:
  `frontend/src/services/api.js`; route guards: `frontend/src/components/{AdminRoute,ClientRoute}.js`.

Do **not** change CORS, the data adapter, or unrelated routes to "fix" a login bug unless the
evidence points there. Preserve every invariant in `protected-invariants.md`.

## 4. Error-message sanitization issues (a leak, or a wrong member-facing string)

Change **only**:
- The centralized sanitizer: `frontend/src/services/authDiagnostics.js` (`SAFE_GENERIC_MESSAGE`,
  `sanitizeError`, `classifyTransport`, `diagnosticsVisible`).
- The **caller** page's rendering if it fails to route errors through the sanitizer:
  `frontend/src/pages/{Login,client/ClientLogin,admin/AdminLogin,Join,client/ClientDashboardEnhanced}.js`.
- Backend message text / `code` for a specific handler: the individual `backend/routes/**`
  file (keep the `{ error, code? }` shape).
- The backend generic-error boundary: `backend/server-crm.js` global error handler
  (`:396-410`) — only if the leak is server-side.

Do **not** add new user-facing internals anywhere. The sanitizer is the single contract;
new callers must go through it.

## 5. Files that should NOT be touched unless the issue specifically requires them

These are shared foundations. Touch only when the verified root cause is inside them:
- `backend/server-crm.js` (wiring, CORS, health, error boundary).
- `backend/db/mysqlAdapter.js` (the entire data layer).
- `backend/middleware/authEnhanced.js` (token/cookie/role core).
- `backend/models/User.js` (identity + roles).
- `backend/middleware/{validation,normalize,rateLimiter}.js` (shared input/abuse contract).
- `backend/utils/proxy/tools.js` (registry + CORS allowlist source).
- `frontend/src/services/api.js`, `authService.js`, `authDiagnostics.js`.
- `frontend/src/App.js` (route table + domain guard).
- `frontend/src/components/{AdminRoute,ClientRoute}.js`.
- Any gateway `server.js` (unless the bug is in that specific tool's proxy).
- `chrome-extension/js/background.js` (the extension runtime core).
- Any `deploy-*.sh`, `deploy-lib.sh`, `.github/workflows/deploy-frontend.yml`,
  `frontend/app.htaccess` (deployment/infra).

## 6. Critical shared files requiring regression testing after ANY change

If a change lands in one of these, run the regression set in `blast-radius-map.md` for it:
- `backend/db/mysqlAdapter.js` → run `backend` unit tests (`npm test` in `backend`) + smoke
  every affected model.
- `backend/middleware/authEnhanced.js`, `backend/routes/authEnhanced.js` → full auth matrix
  (admin login, client login, refresh, logout, `/me`, device-pending, rate-limit).
- `backend/models/User.js` → auth + admin clients + extension activation.
- `frontend/src/services/{api,authService,authDiagnostics}.js` → login/refresh/logout on both
  panels + one authenticated data load + one forced-failure (offline) to confirm the safe
  message.
- `frontend/src/App.js`, `AdminRoute.js`, `ClientRoute.js` → every guarded route still gates.
- `backend/utils/proxy/tools.js` → CORS preflight from each gateway origin + each proxy tool
  open.

## 7. Prohibited unrelated changes during a targeted fix

While fixing one issue, do **not**:
- Rename/move files, reorganize folders, or "clean up" imports outside the touched file.
- Upgrade or add dependencies (`backend/package.json` pins are intentional; no `^`).
- Change cookie flags, JWT secrets/expiries, CORS allowlist, or `sameSite`/`secure` unless the
  bug is exactly there.
- Alter the `mysqlAdapter` query semantics or table shapes as a side effect.
- Modify `.htaccess`, deploy scripts, or the CI workflow unless deploying is the issue.
- Replace the ad-hoc `{ error, code }` responses with a new error framework.
- Remove the documented verified discrepancies (refresh-token-not-a-JWT; DB `expiresAt`
  hardcoded to 7 days) opportunistically — those are separate, deliberate decisions.
- "Modernize" the Mongoose-emulation adapter, the gateway native-HTTP code, or the extension.

---

## Quick map: symptom → boundary

| Symptom | Primary boundary | Never touch (unless root cause) |
|---|---|---|
| Button/layout/text wrong | the page + local component + styles | services, App.js, backend |
| "Unable to complete your request" on login | `authDiagnostics.js` + the login page + network path | mysqlAdapter, unrelated routes |
| Login rejects valid creds | `routes/authEnhanced.js` (email match / password / device) | CORS, adapter, frontend |
| Silent logout / 401 loop | `services/api.js` refresh + `middleware/authEnhanced.js` | models, gateways |
| CORS blocked origin | `ALLOWED_ORIGINS` env or `server-crm.js` cors block | routes, DB |
| Tool won't open via gateway | that gateway's `server.js` + `routes/proxy|stealth/gateway.js` | other gateways, auth |
| Extension can't auth | `chrome-extension/js/background.js` + `routes/extension/index.js` | frontend, gateways |
| Data query wrong/slow | the model file; `mysqlAdapter.js` only if the engine is at fault | routes unrelated to it |
| Deploy didn't land | the relevant `deploy-*.sh` / workflow / `.htaccess` | application code |
