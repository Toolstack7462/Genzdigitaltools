# WriteHuman 70–90 minute capture — browser-console version

No cookie handling, no setup. Runs in the page that is already signed in.

**Do this:**

1. Open `https://app.genzdigitalstore.com/admin/writehuman` and make sure it is loaded and live.
2. Open DevTools → Console.
3. Paste the snippet below and press Enter.
4. **Leave the RDP browser alone for the whole run.** Not touching it is the test.
5. When it finishes it prints a summary and downloads `writehuman-capture.ndjson`. Send me that file, or paste the summary.

You can close DevTools but **not the tab** — a background tab is throttled, so keep it visible if you can, or accept slightly irregular sample spacing (the timestamps are recorded, so irregular spacing does not spoil the reading).

```js
(async () => {
  const MINUTES = 90, EVERY = 60;              // 90 minutes, one sample a minute
  const API = 'https://api.genzdigitalstore.com/api/crm/admin/proxy-tools/writehuman/agent-state';
  const rows = [];
  const pick = (s, t) => { const a = s.account||{}, ag = s.agent||null, hs = s.healthSignals||null, v = a.verification||{}; return {
    t, lifecycleState: s.lifecycleState??null, health: s.health??null, loginRequired: s.loginRequired??null,
    session: hs?.session?.state??null, verification: hs?.verification?.state??null, agentHealth: hs?.agent?.state??null,
    chromeHealth: hs?.chrome?.state??null, cookieSync: hs?.cookieSync?.state??null, summary: hs?.summary??null,
    workingUnverified: a.workingUnverified??null, agentStale: a.agentStale??null, syncStale: a.syncStale??null,
    accessTokenExpiresInSec: a.accessTokenExpiresInSec ?? s.accessTokenExpiresInSec ?? null, tokenExpired: a.tokenExpired??null,
    refreshTokenPresent: s.refreshTokenPresent??null, lastVerifiedAt: a.lastVerifiedAt??null,
    verifyResult: v.result??null, verifyHttp: v.httpStatus??null, lastSyncedAt: a.lastSyncedAt??null,
    syncStaleSec: a.staleSec??null, syncCount: a.syncCount??null, lastAgentSeenAt: s.lastAgentSeenAt??null,
    agentSeenSec: a.agentSeenSec??null, bundleVersion: s.bundleVersion??null, browserAuthCookies: a.browserAuthCookies??null,
    cdp: ag?.cdp??null, agentReportAt: ag?.receivedAt??null,
    activeSource: s.activeSource?.name ?? s.activeSource?.deviceId ?? null,
    activeSourceOnline: s.activeSource?.online??null, onlineDeviceCount: s.onlineDeviceCount??null,
    pendingCommands: (s.pendingCommands||[]).map(c => c.type + '->' + (c.targetDeviceName||c.targetDeviceId)) }; };
  const n = Math.ceil(MINUTES*60/EVERY);
  console.log(`capturing ${MINUTES} min, ${n} samples — leave the RDP browser alone`);
  for (let i = 0; i < n; i++) {
    const t = new Date().toISOString();
    try {
      const r = await fetch(API, { credentials: 'include', headers: { accept: 'application/json' } });
      const row = r.ok ? pick(await r.json(), t) : { t, error: 'http_' + r.status };
      rows.push(row);
      const tok = row.accessTokenExpiresInSec == null ? '—' : Math.round(row.accessTokenExpiresInSec/60) + 'm';
      console.log(`[${i+1}/${n}] ${t.slice(11,19)} ${row.error || `${row.session||row.lifecycleState} token ${tok} verify ${row.verification||row.verifyResult} agent ${row.agentHealth||(row.agentStale?'stale':'live')} bundle ${row.bundleVersion}`}`);
    } catch (e) { rows.push({ t, error: String(e.message) }); }
    if (i < n-1) await new Promise(r => setTimeout(r, EVERY*1000));
  }
  const good = rows.filter(r => !r.error);
  const expired = good.filter(r => r.accessTokenExpiresInSec != null && r.accessTokenExpiresInSec <= 0);
  const bad = good.filter(r => (r.session||r.lifecycleState) && (r.session||r.lifecycleState) !== 'HEALTHY');
  const rot = good.filter((r,i) => i>0 && good[i-1].bundleVersion !== r.bundleVersion);
  console.log('=== VERDICT ===');
  console.log('samples', good.length, '| token expired in', expired.length, '| rotations', rot.length, '| NOT healthy in', bad.length);
  if (expired.length && !bad.length) console.log('PASS — the token aged out and the session stayed HEALTHY throughout.');
  else if (bad.length) console.log('LOOK AT — first non-healthy sample:', bad[0]);
  const blob = new Blob([rows.map(r => JSON.stringify(r)).join('\n')], { type: 'application/x-ndjson' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'writehuman-capture.ndjson'; a.click();
  window.__whCapture = rows;
})();
```

## What I am looking for in the result

| Reading | Before the fix | After the fix |
|---|---|---|
| `accessTokenExpiresInSec` goes ≤ 0 | happens once an hour | still happens — that is normal |
| `session` at that moment | `RECONNECTING` / health `degraded` | **`HEALTHY`** |
| `verification` at that moment | result flips to `unknown`, HTTP 0 | **`due`**, then back to `recent` |
| Cards on the page | Session, Sync agent, Cookie sync all amber | only Verification changes |
| Time to recover | until you refresh the RDP browser | automatic, within minutes |
| `bundleVersion` increments | 63–86 min apart (late) | ~55 min apart (nudged, on time) |

The one number that proves the whole thing: **`session NOT healthy` should be 0** across a window in which `access token expired` is non-zero.
