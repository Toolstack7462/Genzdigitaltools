# One-Time POST Launch Bootstrap (Claude AI + StealthWriter)

Removes lease/JWT values from tool-launch URLs. Additive, feature-flagged, and reversible
without a redeploy. Applies to **Claude AI** and **StealthWriter** only — every other proxy
tool (HIX, BypassGPT, ChatGPT, Ryne, Grok, WriteHuman) keeps its existing URL flow untouched.

---

## 1. The problem this replaces

The old launch was:

```
Dashboard click
  → POST /client/proxy-tools/claude/open        (or /client/stealth/open)
  → { url: "https://claude1…/gateway?lease=<JWT>" }
  → window.open(url)
  → gateway sets a cookie, 302 to the tool
```

Four concrete weaknesses:

| # | Weakness | Consequence |
|---|---|---|
| 1 | The lease JWT sat in a **query string** | Address bar, browser history, the `Referer` of the first upstream request, and every proxy/CDN/server access log on the path. Anyone reading that URL later could resume the session for the rest of its TTL. |
| 2 | The JWT is **readable** (`sub`, `tool`, `acid`, `exp`) | Base64-decoding the URL reveals the client id, which tool, and which shared vault account served them. |
| 3 | StealthWriter stored it in a **non-HttpOnly `sw_lease` cookie** | Deliberately readable, because the injected overlay lifted it back out to authenticate its own `/validate` and `/consume` calls. Any script on the page — or any cookie-editor extension — could take a working bearer credential. |
| 4 | **No CSRF protection** on the open routes | Auth cookies are `SameSite=None` in production. A plain `<form method=POST>` is a *simple request*, so it is never preflighted: any page a logged-in client visited could force a launch, burning leases, consuming shared Claude token allowance and bumping account usage. CORS blocks reading the response, not sending the request. |

Claude already exchanged the URL lease for an opaque `__Host-claude_session` cookie once it
reached the gateway, so weakness 3 was Claude-clear — but 1, 2 and 4 applied to both tools.

---

## 2. The flow now

```
Dashboard click
  → GET  /api/crm/launch-token              (once per tab; HttpOnly cookie + token in body)
  → POST /client/proxy-tools/claude/open    with X-CSRF-Token
       · validates client, subscription, tool grant, expiry, assigned account, quota
       · creates the lease ROW  (no JWT is signed here at all)
       · mints a 256-bit one-time launch code, stored as a SHA-256 digest, TTL 30–60s
  → { launch: { url: "https://claude1…/launch", field: "code", code, expiresInSeconds } }
  → hidden <form method=POST target=_blank> submits the code in the BODY
  → gateway POSTs /proxy/gateway/redeem-launch  (X-Gateway-Key, code in the body)
       · redeems ATOMICALLY, exactly once
       · RE-CHECKS lease revoked/expired + client active/plan
       · signs the lease JWT for the lease row's REMAINING life
       · returns it server-to-server — it never touches the browser
  → gateway stores the JWT in its opaque session store
  → 303 → clean tool URL, with only  __Host-claude_session  /  __Host-stealth_session
```

**Nothing sensitive is ever in a URL.** The browser holds one opaque random id; the lease JWT
exists only in gateway memory and its encrypted on-disk session store.

---

## 3. Why redemption is a `DELETE`, not a `used` flag

`db/mysqlAdapter.js` implements `findOneAndUpdate` as a **read, then a JS merge, then a
write**. The natural design —

```js
findOneAndUpdate({ _id, used: { $ne: true } }, { $set: { used: true } })
```

— lets two concurrent redemptions both read `used:false` and both succeed. A double-click is
enough.

So the launch code's SHA-256 digest **is the row's primary key**, and redemption is
`DELETE FROM launch_codes WHERE id = ?`. InnoDB serializes the row delete and MySQL reports
`affectedRows` exactly: the first caller gets 1, every later caller gets 0. `deletedCount === 1`
is the single, database-enforced answer to "did I win", and the row is gone before the lease is
handed back.

`backend/tests/launchBootstrap.test.js` → *CONCURRENCY* and *REPLAY* both fail against the
naive design and pass against this one (verified).

---

## 4. Files

**New**

| File | Purpose |
|---|---|
| `backend/utils/launchCode.js` | Code format, hashing, TTL clamp, rollout flags |
| `backend/utils/launchStore.js` | `issue()` / atomic `redeem()` / `sweepExpired()` |
| `backend/models/LaunchCode.js` | The `launch_codes` row (digest = primary key) |
| `backend/middleware/csrf.js` | Double-submit CSRF for launch POSTs |
| `backend/routes/launchToken.js` | `GET /api/crm/launch-token` |
| `frontend/src/services/launchService.js` | CSRF fetch/retry + hidden form POST |
| `deploy-stealth-gateway.sh` | There was no StealthWriter gateway deploy path before |
| `backend/tests/launchBootstrap.test.js` | 15 tests |
| `claude-gateway/test/launchBootstrap.test.js` | 17 tests |
| `stealth-gateway/test/launchBootstrap.test.js` | 20 tests |

**Modified**

| File | Change |
|---|---|
| `backend/db/mysqlAdapter.js` | +1 table registration (`launch_codes`) |
| `backend/routes/client/proxyTools.js` | CSRF gate; issue a code instead of signing a JWT (flagged) |
| `backend/routes/client/stealth.js` | Same |
| `backend/routes/admin/proxyTools.js` | Same, for the capture lease |
| `backend/routes/admin/stealth.js` | Same, for the capture lease |
| `backend/routes/proxy/gateway.js` | `POST /redeem-launch` (gateway-key) with full re-validation |
| `backend/routes/stealth/gateway.js` | Same |
| `backend/utils/proxy/lease.js`, `backend/utils/stealth/lease.js` | Optional exact `ttlSeconds` |
| `backend/utils/proxy/tools.js`, `backend/utils/stealth/lease.js` | `gatewayLaunchUrl()` |
| `backend/server-crm.js` | Mount the launch-token route |
| `claude-gateway/server.js` | `POST /launch`, `ALLOW_URL_LEASE`, `Referrer-Policy` |
| `stealth-gateway/server.js` | Opaque durable session store, `POST /launch`, same-origin `/__genz/validate` + `/__genz/consume`, `ALLOW_URL_LEASE`, `Referrer-Policy` |
| `stealth-gateway/public/overlay.js` | Same-origin API instead of reading `sw_lease` |
| `frontend/…` (4 call sites) | Use `launchService` |
| `deploy-hostinger.sh` | Ship the new backend require-graph |

---

## 5. Flags

| Flag | Where | Default | Effect |
|---|---|---|---|
| `LAUNCH_FLOW` | backend | `post` | `url` = global rollback to the old flow, all modules |
| `LAUNCH_FLOW_TOOLS` | backend | `claude` | Which proxy tools use the POST flow |
| `STEALTH_LAUNCH_FLOW` | backend | `post` | `url` = roll StealthWriter back alone |
| `LAUNCH_CODE_TTL_SECONDS` | backend | `45` | Clamped to 30–60 |
| `LAUNCH_CSRF_ENFORCE` | backend | `1` | `0` = validate and log, but do not reject |
| `ALLOW_URL_LEASE` | both gateways | `1` | `0` = refuse `/gateway?lease=` entirely |

---

## 6. Deployment order (matters)

1. **Frontend first.** A new frontend against an old backend gets a 404 from
   `/launch-token`, sends no CSRF header, receives `{url}` and calls `window.open` — i.e. the
   old flow, working. The reverse order would 403 every launch.
2. **Backend** (`deploy-hostinger.sh`). `ensureTables()` creates `launch_codes` at boot
   (`CREATE TABLE IF NOT EXISTS`).
3. **Gateways** (`deploy-claude-gateway.sh`, `deploy-stealth-gateway.sh`), with
   `ALLOW_URL_LEASE=1`.
4. Verify in production (see §7).
5. **Only then** set `SetEnv ALLOW_URL_LEASE 0` in both gateways' `.htaccess` and restart.
   That is the moment the lease genuinely stops being URL-reachable.

---

## 7. Rollback

Fastest first. None of these require a code deploy.

| Symptom | Action | Effect |
|---|---|---|
| Launches 403 with `csrf_invalid` | `SetEnv LAUNCH_CSRF_ENFORCE 0` + restart backend | CSRF validates and logs but stops rejecting |
| Claude or StealthWriter will not open | `SetEnv LAUNCH_FLOW url` + restart backend | Both tools return to `?lease=` URLs. **Requires `ALLOW_URL_LEASE=1` on the gateways** — which is why step 5 above is last. |
| Only StealthWriter is affected | `SetEnv STEALTH_LAUNCH_FLOW url` | Rolls back StealthWriter alone; Claude keeps the POST flow |
| A gateway is bad | Re-run its deploy script from the previous commit | Gateways are independent of each other and of the backend |

Rolling back the backend alone is sufficient and safe: the gateways accept both entry points
while `ALLOW_URL_LEASE=1`.

**In-flight sessions survive every rollback.** Leases already issued keep working — the
gateways still resolve a lease from an existing opaque session, and StealthWriter additionally
still accepts a legacy `sw_lease` cookie for sessions that predate the deploy.

---

## 8. What was deliberately NOT changed

Session duration and the lease TTL resolution chain; Claude token quotas, 5-hour and weekly
windows, and the open-time quota gate; StealthWriter daily Humanizer/Detector limits, `/consume`
metering and reset labels; account selection including Claude pinning and StealthWriter
`accountPinMode`; Personal/Team workspace switching; Cloudflare passthrough and the mobile
identity handling; downloads, uploads and the working areas; and every other proxy tool.

The lease **row** remains the sole authority for revocation and expiry, and it is re-read at
redemption — so an admin revoke between the click and the landing still wins.
