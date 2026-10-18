# Mark as Active — the original incident: differential diagnosis

**Status: NOT DIAGNOSED. One candidate path is confirmed to exist in the code; it is not confirmed
to be the cause.**

This file is the investigation. `MARK-ACTIVE-EVIDENCE-CAPTURE.md` is the procedure for getting the
one field that would close it.

## 1. Evidence actually held

| Field | Value |
|---|---|
| Symptom, as reported | *"new source → Mark as Active fails"* |
| HTTP status | **unknown** |
| `code` | **unknown** |
| `state` | **unknown** |
| `activationId` | **unknown** |
| `targetDeviceId` | **unknown** |
| `failureCode` / `stage` / `stageAt` from `/activation` | **unknown** |
| Time of the attempt | **unknown** |
| Agent version on the target | **unknown** |
| Screenshot or copied error text | **none supplied** |

No new attempt was made to obtain these. No failure was manufactured, no live source was switched,
and nothing was pressed in production. The repository holds no prior capture either — searched.

**One sentence is still enough to start.** It constrains the problem usefully in two ways: the
device was *newly added*, and the failure was visible to the operator at the moment of pressing
(not a silent no-op discovered later). The work below is what can be concluded from that plus the
source, and it is deliberately framed so that **one** code from the next real error picks a single
row out of it.

## 2. The control: a healthy new device is not refused

Pinned by `backend/tests/writehumanNewSourceRefusals.test.js`.

A just-paired device that is heartbeating, holds a per-agent credential and runs agent 3.5.15
passes `deviceState.canActivate()` **and** `agentCommands.validateTarget(…, requireOnline,
requireCommandSupport, requireActivationSupport)`. A non-active device is also **not** refused
merely for not being the active source — `requireActiveSource: false` is passed on this route.

So this is **not** a blanket "newly added sources can never be activated" defect in the
eligibility layer. The failure is one of the specific conditions below, or it is downstream of the
command being queued (on the device), which no code reading here can settle.

## 3. The differential

Every refusal a just-paired device can receive, each with the code that identifies it. All of these
are returned **before** any command is minted, so each is a `409`/`404` with nothing queued.

| # | Condition | Code the operator would see | Fits "new source"? |
|---|---|---|---|
| 1 | Agent installed but has not heartbeated yet | `DEVICE_OFFLINE` | **Strongly** — pairing and first heartbeat are separate steps |
| 2 | Last heartbeat older than the 10-min window (`PROXY_AGENT_STALE_MIN`) | `DEVICE_OFFLINE` | **Strongly** |
| 3 | Paired without completing key enrolment (`keyHash` absent) | `DEVICE_NO_CREDENTIAL` | Plausibly |
| 4 | Older enrolment of the same machine still heartbeating — **see §4** | `DEVICE_SUPERSEDED` | **Strongly** |
| 5 | Agent below `MIN_ACTIVATION_AGENT_VERSION` (3.5.0) | `ACTIVATION_VERSION_UNSUPPORTED` | Plausibly — an old build on the new machine |
| 6 | Agent below `MIN_AGENT_VERSION` (3.4.0), or not reporting a version | `COMMAND_VERSION_UNSUPPORTED` | Plausibly |
| 7 | A device record that is revoked / uninstalled | `DEVICE_REVOKED` / `DEVICE_UNINSTALLED` | Unlikely for a new pairing |
| 8 | Wrong/absent device id reaching the route | `DEVICE_UNKNOWN` | Unlikely |
| 9 | An **earlier** failure latched the device into `ERROR` | `DEVICE_ERROR` | Only on a second press — **see §5** |
| 10 | Command queued, device then failed the capture or the expected-account check | `200` first, failure later in `/activation` | Possible — would NOT look like a failed press |
| 11 | DB saturation or another server fault | `503 DB_BUSY` / `500` | Possible; **indeterminate**, see capture doc §5 |

Rows 1–8 are each a single distinct code, which is why one screenshot resolves this. Rows 10 and 11
are the two that a status code alone does **not** resolve.

## 4. The one defect-shaped finding: supersede ignores `pairedAt`

`deviceSync.isSupersededDevice()` judges a device superseded when another non-revoked device shares
its `name` and has a **newer `lastSeenAt`**. It never reads `pairedAt`.

"Newest heartbeat wins" is not the same rule as "newest enrolment wins", and the two disagree in
precisely the scenario the symptom describes:

> The agent is reinstalled on a machine — a reinstall mints a fresh `deviceId`, so a second record
> appears with the same `name`. The **old** agent is still installed and still heartbeating from
> that host. The old record therefore carries the newer `lastSeenAt`, and the **new** record — the
> one just paired, the one the operator is trying to activate — is the one judged superseded.
> `Mark as Active` then refuses it with `DEVICE_SUPERSEDED`.

This is confirmed to be the code's actual behaviour (`writehumanNewSourceRefusals.test.js`,
*"a newly paired device loses to an older record that is still heartbeating"* — it also asserts the
new record is the newer one by `pairedAt`, the field the rule does not consult).

**It is not confirmed to be the cause of the incident.** `DEVICE_SUPERSEDED` in the operator's
error would support it; **any other code rules it out.**

**Deliberately not changed here.** The rule's job is to stop a command being addressed to a stale
enrolment of a working source, and a test pins that it still does that (an abandoned old row is
still superseded; the active source is never superseded whatever the heartbeats say). Loosening a
supersede check on a hypothesis, with no error code to confirm it, risks addressing a
capture-and-activate to the wrong enrolment of a live source — a worse outcome than the refusal.
When the evidence arrives, the fix to evaluate is tie-breaking on `pairedAt` when both records are
for the same name, not removing the check.

## 5. Why a second press reports a different cause

`deviceState` ranks `ERROR` above `READY`, and `canActivate()` admits only `READY`/`STANDBY`.
`ERROR` is latched by `ACCOUNT_MISMATCH`, `PROMOTION_FAILED`, `REPLAY_REJECTED`,
`CANDIDATE_SCHEMA_INVALID` or `ROLLBACK_COMPLETED`.

So if the device was pressed more than once, the captured code is likely `DEVICE_ERROR` — which
describes the *latch*, not the original failure. The original is in `/activation`'s `failureCode`.
This is the one case where the older record is the relevant evidence, and it must be labelled as
such.

## 6. What would close this

In order of how much it settles, cheapest first — **none of it requires a new press**:

1. **The code** from the original error (screenshot, copied text, or a support message). One field,
   and rows 1–9 collapse to one.
2. **`GET …/activation`** for that account: `failureCode`, `stage`, `stageAt`, `activationId`,
   `targetDeviceId`. Correlate it per capture doc §4 — it may be `null` or describe a different
   attempt.
3. **The admin device list** for that account at the time: two records with the same `name`, and
   which one was heartbeating, decides §4 directly.
4. **Server logs** around the timestamp: `Proxy make-active error:` is logged only for the `500`
   path, so its *absence* is itself informative — it argues against row 11.

Until at least (1) exists, no fix should be written for this incident. The `DB_BUSY` work on this
route is error-reporting hygiene and is **not** a candidate cause; it is row 11's reporting, not
its explanation.
