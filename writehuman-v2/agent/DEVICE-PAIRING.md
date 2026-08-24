# Pairing a device for WriteHuman cookie sync

You can keep the WriteHuman account signed in on **several machines at once** — your local PC, an
RDP box, a second RDP. Each runs the same agent. Whichever machine has the **freshest verified
login** becomes the active cookie source automatically. Moving where you sign in needs no change
on the server and no change to any config file.

## How the handover works

The server does not trust arrival order, or the agent's word, to decide which bundle is newest.
It reads the `iat` (issued-at) claim of the Supabase access token *inside* the candidate — a value
signed by Supabase, so no device can forge its way to the front of the queue.

```
candidate token newer than the active one  ->  verify it, then promote + switch source
candidate token identical                  ->  same session seen twice, no switch (no ping-pong)
candidate token older                      ->  rejected as STALE_BUNDLE, active bundle untouched
```

A candidate is only ever promoted **after** it independently proves it can authenticate as the
expected account. Until then the live bundle is not touched, so a device pushing dead cookies
cannot take the session down.

## Pairing a machine

1. In **Admin → WriteHuman → Sync devices**, type a name (`LOCAL-PC`, `RDP-01`) and press
   **Pair device**. A single-use code appears. It is shown **once** — nothing can retrieve it
   again; if you lose it, generate another.
2. On that machine, start the agent once with the code:

   ```powershell
   $env:WHV2_PAIR_CODE = "ABCDE-FGHIJ"
   node C:\Projects\writehuman-v2\agent\cookie-sync-agent.js
   ```

   The agent redeems the code, receives its own device key, and writes it to
   `agent-device.json` (owner-only). **The code is not needed again** — remove it from the
   environment after the first successful start.
3. Sign in to WriteHuman normally in that machine's debug Chrome. The agent syncs the resulting
   session; it never logs in for you and never touches credentials.

The code expires in 15 minutes and cannot be redeemed twice.

## What the agent reads

Only the WriteHuman Supabase auth cookies — `sb-<projectRef>-auth-token` (including its `.0`/`.1`
chunks) and `sb-session-token`, on `writehuman.ai`. The allowlist is applied on the device *and*
again on the server, so a bundle containing anything else has the extras dropped before it can
reach the vault. Cookie values are never logged on either side; logs carry counts and an 8-character
hash prefix.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `WHV2_PAIR_CODE` | — | One-time pairing code. Only needed for the first start. |
| `WHV2_DEVICE_NAME` | hostname | Name shown in the dashboard. |
| `WHV2_DEVICE_STATE` | `../agent-device.json` | Where this machine's device id + key live. |
| `WHV2_CHROME_PROFILE` | - | Profile this device may read. Checked against Chrome's own reported user-data-dir; a mismatch refuses to sync rather than reading the wrong profile. |
| `WHV2_POLL_MS` | 120000 | Reconciliation interval. |
| `WHV2_QUICK_POLL_MS` | 15000 | Faster interval used briefly after a cookie change. |
| `WHV2_QUICK_POLL_COUNT` | 4 | How many quick polls follow a change. |

Polling is deliberately low-frequency: a hash comparison every two minutes, briefly faster after a
real change. There is no per-second polling, no process per heartbeat and no browser launched to
check status.

## Revoking

**Revoke** in the dashboard removes a device's right to *write*. It never deletes the stored cookie
bundle — the session that device supplied keeps working. Revoking the only device that supplies the
active session is refused unless you confirm, so you cannot accidentally strand yourself with a
session nothing can refresh.

## If a device goes offline

Nothing breaks. The last verified bundle stays active and clients keep working. The dashboard shows
the source as offline and stops presenting that device's telemetry as current — a stale reading is
reported as "last seen 3h ago", never as "connected".
