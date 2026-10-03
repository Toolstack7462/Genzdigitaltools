# Live gateway snapshots — 2026-10-03

Byte copies of the code these gateways were actually running on 2026-10-03, pulled
read-only from the server (`~/<name>/`). No `.env` or secrets. **Reference only — nothing
deploys from this folder.**

| Gateway | Live `server.js` | Why it is saved |
|---|---|---|
| hix-gateway | hand-edited 2026-07-21, matches **no commit** | carries `CAPTCHA_SELFPROXY_ORIGIN` (HIX captcha fix) that exists nowhere else in git; redeploying `proxy-gateway/` would drop it |
| bypassgpt-gateway | hand-edited 2026-07-21, matches no commit | older form of `proxy-gateway/server.js`; kept so the exact live state is recoverable |
| grok-gateway | hand-edited 2026-07-21, matches no commit | older form of `grok-gateway/server.js`; same reason |

All three were asleep (Admin → Proxy Services, 2026-08-22) when captured, and their overlays
lack 918c798 (confirmed-denial vs transient-failure). Before waking one, either redeploy it
from `proxy-gateway/` (Hix: port `CAPTCHA_SELFPROXY_ORIGIN` first) or accept the old overlay.

Ryne and WriteHuman1 were also behind git but had **no** live-only code (git is a strict
superset), so they are not snapshotted — `scripts/deploy-gateways.sh ryne writehuman`
upgrades them without losing anything.
