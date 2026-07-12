# Targeted-Fix Protocol (As-Built)

> ## ⚠️ MANDATORY
> **Future fixes must be surgical. Do not modify unrelated modules, security controls,
> authentication flows, API contracts, database behaviour, deployment settings, or UI
> components unless the verified root cause requires it. A single issue must not trigger a
> broad refactor.**

This is the required process for **every** future issue in this repository.

---

## The 10 steps

### Step 1 — Reproduce the issue
Get an exact, repeatable trigger: role (admin/client/anonymous/extension), host
(main/app/api/gateway subdomain), page or endpoint, and the observed vs expected result.
Capture the `X-Request-Id` / on-screen "Error ID" if it is an auth/API failure — it correlates
to the backend `[auth:*]`/`[login-diag]` logs.

### Step 2 — Identify the exact failing code path
Trace it with `docs/architecture/request-flow.md`. Name the precise file(s) and function(s)
where behaviour diverges. Distinguish transport failure (no HTTP response) from a server
response — the frontend `authDiagnostics.js` already separates these.

### Step 3 — Determine the smallest affected component
Map the symptom to a boundary using `docs/architecture/change-boundaries.md` §"symptom →
boundary". The fix should live in the **smallest** component that owns the behaviour (a page, a
service, one route, one model, one gateway) — not a shared foundation, unless Step 4 proves the
root cause is there.

### Step 4 — Inspect git history for the previous working behaviour
```bash
git log --oneline -- <path/to/file>
git log -p -S "<symbol or string>" -- <path>   # when a line changed
git blame <path>                                 # who/what last touched the line
```
If the behaviour used to work, find the commit that changed it and prefer restoring the intended
behaviour over inventing a new mechanism. This repo has a detailed commit history (e.g. the
"centralize error sanitizer", "login email case-sensitivity" fixes) — use it.

### Step 5 — Modify only the minimum required files
Change the fewest files that fix the verified root cause. Respect the boundaries in
`change-boundaries.md`. Do **not** open shared files (`server-crm.js`, `mysqlAdapter.js`,
`middleware/authEnhanced.js`, `services/api.js`, `authDiagnostics.js`, `App.js`) unless the root
cause is inside them.

### Step 6 — Do not refactor unrelated code
No renames, no import reshuffling, no dependency bumps, no "while I'm here" cleanups outside the
touched lines. Match the surrounding code's style. Keep the existing `{ error, code? }` response
shape and the Mongoose-emulation query idioms.

### Step 7 — Preserve all protected invariants
Re-read `docs/architecture/protected-invariants.md` and confirm your change keeps every relevant
invariant: TLS/cookie flags, CORS allowlist (incl. the three in-code first-party origins),
token rotation + `tokenVersion` gate, device fail-open, role/cookie isolation, hashed/encrypted
storage, API response contracts, and production error sanitization.

### Step 8 — Test the affected flow
Exercise the exact reproduction from Step 1 and confirm it now behaves correctly, across the
relevant role and host. For auth/error changes, verify a production-style build still shows only
safe messages (`diagnosticsVisible()` is dev-only).

### Step 9 — Run regression tests for dependent components
Use `docs/architecture/blast-radius-map.md` for the touched file and run its "Mandatory tests".
At minimum:
```bash
cd backend && npm test        # adapter + semver + renewalWindow suites
node --check backend/server-crm.js   # (npm run check covers key files)
```
Plus the manual smoke set for the affected surface (login matrix, one authed data load, a
forced-offline login for the safe message, guarded-route gating, or the specific gateway/
extension flow).

### Step 10 — Report exactly what changed
State the precise list of files modified, the root cause, why the change is minimal, which
invariants were checked, and which regression tests were run. Explicitly confirm that unrelated
files were **not** modified:
```bash
git status --porcelain        # should list only the intended files
git diff --stat
```

---

## Deploy note (only if the fix ships)
- Frontend: pushing to `main` under `frontend/**` triggers `.github/workflows/deploy-frontend.yml`
  (build → SFTP to both roots → live-bundle-hash verify). Manual: `deploy-frontend-only.sh`.
- Backend: **no CI** — use `deploy-backend.sh <backend/rel/path.js> ...` (SHA-256-verified
  per-file upload + restart + boot wait). Never upload `.env`.
- A gateway: `deploy-claude-gateway.sh` (or the tool's equivalent) — uploads only
  `server.js`/`package.json`/`public/overlay.*`, restarts, verifies `/__genz/health`.
- Confirm health after deploy: `/api/crm/health` 200 (backend) or `/__genz/health` 200 (gateway).

## Do-not list (repeat)
- Do not touch security controls, auth flows, CORS, cookie flags, JWT config, or the DB adapter
  as a side effect.
- Do not upgrade/add dependencies (`backend/package.json` is intentionally pinned, no `^`).
- Do not overwrite the app-subdomain `.htaccess` or change deploy targets.
- Do not "modernize" the adapter, gateways, or extension.
- Do not remove the documented verified discrepancies opportunistically.
