# Mark as Active — the original incident: differential diagnosis

**Status: NOT DIAGNOSED, and no candidate is confirmed.** The differential below is a shortlist
built from the code; every field of the actual failure is still **UNKNOWN**. The supersede lead that
an earlier revision called strong is corrected in §4 — it cannot refuse an online device.

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
| 4 | Explicit `supersededBy` from re-enrolment, **or** an offline device with a live same-named sibling — **see §4** | `DEVICE_SUPERSEDED` | Only if the device is **not** online |
| 5 | Agent below `MIN_ACTIVATION_AGENT_VERSION` (3.5.0) | `ACTIVATION_VERSION_UNSUPPORTED` | Plausibly — an old build on the new machine |
| 6 | Agent below `MIN_AGENT_VERSION` (3.4.0), or not reporting a version | `COMMAND_VERSION_UNSUPPORTED` | Plausibly |
| 7 | A device record that is revoked / uninstalled | `DEVICE_REVOKED` / `DEVICE_UNINSTALLED` | Unlikely for a new pairing |
| 8 | Wrong/absent device id reaching the route | `DEVICE_UNKNOWN` | Unlikely |
| 9 | An **earlier** failure latched the device into `ERROR` | `DEVICE_ERROR` | Only on a second press — **see §5** |
| 10 | Command queued, device then failed the capture or the expected-account check | `200` first, failure later in `/activation` | Possible — would NOT look like a failed press |
| 11 | DB saturation or another server fault | `503 DB_BUSY` / `500` | Possible; **indeterminate**, see capture doc §5 |

**No single code uniquely diagnoses this incident.** A code narrows the list; it does not close it.
Rows 1 and 2 share `DEVICE_OFFLINE` and are told apart only by the heartbeat timeline; row 4's code
covers two distinct causes (§4); row 9's code describes a *latch* rather than the first failure
(§5); rows 10 and 11 are not resolved by a status code at all. Treat a captured code as the field
that picks a shortlist, then corroborate it — and where it cannot be corroborated, the status stays
**UNKNOWN**.

## 4. Supersede: a weak lead, corrected

An earlier revision of this file presented `deviceSync.isSupersededDevice()` as a strong candidate
for this incident. **That was overstated and is corrected here.**

The rule does decide by `name` and `lastSeenAt` and never reads `pairedAt`. But its second guard is
`if (isOnline(dev, staleMs)) return false`, so **it cannot refuse a device that is heartbeating** —
however many same-named records exist, and even when an older one heartbeated more recently. A
control test pins exactly that: a healthy, online, credentialled new source passes every gate with
an older sibling seen more recently.

The earlier fixture was also impossible: a device paired one minute ago whose last heartbeat was
eleven minutes ago. Pairing *is* contact, so `lastSeenAt` cannot predate `pairedAt`. The replacement
fixture is a plausible stale device — paired three days ago, last heard from forty minutes ago.

**What the heuristic actually does on this route** is relabel an *offline* device's refusal: the
supersede check runs before `requireOnline`, so the same offline device is refused
`DEVICE_SUPERSEDED` when a live same-named sibling exists and `DEVICE_OFFLINE` when it does not.
That is its entire effect here. It cannot block a working new source, so it is **not** an
explanation for a device the operator believes is running.

**`DEVICE_SUPERSEDED` identifies a refusal category, not a root cause.** Two different causes share
it: an explicit `supersededBy` flag written by re-enrolment (which *does* refuse an online device,
and is the only way a heartbeating new source sees this code), and the offline-sibling heuristic.
The code alone does not say which, so it narrows the search without closing it.

**Nothing is changed.** No `pairedAt` tie-break is implemented — that would be a speculative fix to
a rule that has not been shown to refuse anything the incident describes, and loosening a supersede
check risks addressing a capture-and-activate to a stale enrolment of a live source. Tests pin that
the rule still supersedes a genuinely abandoned row and never demotes the active source.

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
4. **Server logs** around the timestamp. Note what this log can and cannot show: the handler calls
   `respondIfDbBusy(err, res)` and **returns before** `console.error('Proxy make-active error:', …)`
   runs, so a shed request is answered `503` and logged **nothing**. The absence of that line
   therefore does **not** rule out saturation — it only rules out the `500` branch. A *present*
   line is useful evidence; an absent one is not.

Until at least (1) exists, no fix should be written for this incident. The `DB_BUSY` work on this
route is error-reporting hygiene and is **not** a candidate cause; it is row 11's reporting, not
its explanation.
