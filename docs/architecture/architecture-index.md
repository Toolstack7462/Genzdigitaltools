# Architecture Index (Issue → Component → Files)

> Fast lookup for "one issue, one component". Columns: issue type · responsible component ·
> exact likely files · files that must remain untouched · required regression tests.
> Verified from code. Read with `change-boundaries.md`, `blast-radius-map.md`, and the
> **MANDATORY** rule in `targeted-fix-protocol.md`.

| Issue type | Responsible component | Exact likely files | Must remain untouched | Required regression tests |
|---|---|---|---|---|
| Page layout / text / styling wrong | The specific page + local component | `frontend/src/pages/**/<Page>.js`, its `components/**`, `styles/**`, `tailwind.config.js` | `services/api.js`, `authService.js`, `authDiagnostics.js`, `App.js`, backend | Visual check of the page across light/dark; adjacent pages using the same shared component |
| Shared shell (nav/sidebar/footer) wrong | Layout wrappers | `components/AdminLayoutEnhanced.js`, `ClientLayoutEnhanced.js`, `Navbar.js`, `Footer.js` | route guards, services | Both admin and client panels render + navigate |
| API call fails / wrong base URL | Frontend axios core | `frontend/src/services/api.js`, `frontend/.env.production` | backend auth/db, unrelated routes | Login/refresh both panels + one authed data load |
| CORS blocked origin | Server CORS allowlist | `backend/server-crm.js` (cors block), `ALLOWED_ORIGINS` env, `backend/utils/proxy/tools.js` | routes, models | Preflight from each allowed origin passes; a bad origin is rejected |
| Route 404 at web server | Reverse-proxy rules | `frontend/app.htaccess`, `frontend/public/.htaccess` | application code | Deep-link refresh on `/client/*`, `/admin/*`, `reset-password` |
| Route 404 at API | Route mount / router file | `backend/server-crm.js` mounts, `backend/routes/**/<file>.js` | auth middleware, adapter | The specific endpoint + a sibling endpoint in the same router |
| Login rejects valid credentials | Client/admin login handler | `backend/routes/authEnhanced.js` (`emailMatch`, candidate loop, device) | CORS, `mysqlAdapter.js`, frontend | Lowercase + mixed-case email login; disabled account 403 |
| Silent logout / 401 loop | Token verify + FE refresh | `backend/middleware/authEnhanced.js`, `frontend/src/services/api.js` | models, gateways | Access-token expiry → auto-refresh; bad refresh → correct login redirect |
| Session invalidated unexpectedly | tokenVersion / rotation | `backend/middleware/authEnhanced.js`, `backend/routes/authEnhanced.js` (`handleRefresh`), `models/RefreshToken.js`, `models/User.js` | frontend, CORS | Refresh rotates + revokes; password reset invalidates old session |
| Device "pending/blocked" wrong | Device policy | `backend/models/DeviceProfile.js`, `backend/routes/authEnhanced.js` (device block) | token/cookie core | New device → `DEVICE_PENDING`; resolve-error still logs in (fail open) |
| Rate-limit lockout / shared-IP | Rate limiter | `backend/middleware/rateLimiter.js` | routes | 30 rapid logins → 429; distinct users behind one CDN IP still allowed |
| Member sees API host / internal code / stack | The sanitizer (or a caller bypassing it) | `frontend/src/services/authDiagnostics.js`; caller `pages/{Login,client/ClientLogin,admin/AdminLogin,Join}.js` | backend, api.js interceptor | Offline login shows `SAFE_GENERIC_MESSAGE`; prod build hides internals even with `?debug=1` |
| Server leaks stack / detail | Backend error boundary | `backend/server-crm.js` (global error handler), the specific route | adapter, other routes | Force a 500 in prod mode → generic `Internal server error` |
| Guarded route reachable when it shouldn't be | Route guards / route table | `frontend/src/components/{AdminRoute,ClientRoute}.js`, `frontend/src/App.js` | services, backend | Anonymous → login redirect; wrong role → Access Denied |
| Wrong host redirect / loop | Domain guard / htaccess | `frontend/src/App.js` (`domainGuard`), `frontend/app.htaccess`, `frontend/public/.htaccess` | services | main `/login` → app `/client/login`; email links open SPA |
| Data query wrong / missing rows | The model (adapter only if engine bug) | `backend/models/**/<Model>.js`; `backend/db/mysqlAdapter.js` only if the engine | unrelated routes | `cd backend && npm test`; the model's own reads/writes |
| Query slow | Indexed field / adapter | `backend/db/mysqlAdapter.js` (`INDEXED_FIELDS`), the model | query semantics | `npm test` adapter suites; the slow query path |
| A proxy tool won't open / leaks identity | That gateway | `<tool>-gateway/server.js` + `public/overlay.*`; `backend/routes/proxy|stealth/gateway.js` | other gateways, auth core | Fresh-lease open works; `/__genz/health` 200, `/` 403; account UI hidden |
| Proxy tool registry / CORS for gateway | Proxy registry | `backend/utils/proxy/tools.js` | server-crm CORS logic | Each proxy tool opens; gateway-origin preflight passes |
| Stealth usage limits wrong | Stealth access engine | `backend/utils/stealth/access.js`, `models/stealth/*`, `backend/routes/{admin,client}/stealth.js` | proxy module, auth | Humanizer/detector count decrements; daily reset boundary |
| Extension can't auth / activate | Extension backend + SW | `chrome-extension/js/background.js`, `backend/routes/extension/index.js`, `models/ExtensionToken.js` | frontend, gateways | Activate → `/tools` heartbeat; expired token 401 |
| Extension shield hides too much/little | Shield + config | `chrome-extension/js/shield.js`, `js/config/toolConfigs.js` | background SW auth | Account UI hidden; editor/captcha untouched on each `SHIELD_HOST` |
| Extension update not detected | Release pipeline | `chrome-extension/manifest.json`, `backend/models/ExtensionRelease.js`, `backend/routes/extension/index.js` (`/tools`), `scripts/build-extension.mjs` | frontend | `/tools` returns `extensionUpdate`; dashboard reflects it |
| Email (verify/reset/renewal) not sending | Email util + auth-email routes | `backend/utils/email.js`, `backend/routes/authEmail.js` | auth token core | With Resend configured: verify + reset flow; unconfigured → silently skipped |
| Renewals aggregation wrong | Renewals route + window util | `backend/routes/admin/renewals.js`, `backend/utils/renewalWindow.js` | assignment models | `npm test` renewalWindow; admin Renewals list |
| Deploy didn't land / stale bundle | Deploy script / workflow | the relevant `deploy-*.sh`, `.github/workflows/deploy-frontend.yml`, `.htaccess` | application code | Post-deploy live-bundle-hash check both domains; `/api/crm/health` 200 |

**Rule of thumb:** locate the row, change only the "exact likely files", leave the "must remain
untouched" set alone unless git history + reproduction prove the root cause lives there, then run
the "required regression tests" plus the blast-radius set for any shared file you had to touch.
