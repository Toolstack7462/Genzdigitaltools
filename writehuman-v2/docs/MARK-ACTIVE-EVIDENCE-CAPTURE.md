# Mark as Active — evidence capture

**Status of the original incident: NOT DIAGNOSED.** No failed request from it has been captured, so
there is no root cause here and none should be inferred from anything else in this branch.

The `DB_BUSY` change on this route is **not** a fix for that incident. It corrects how a
*database-saturation* failure is reported (`503 + Retry-After` instead of a generic `500`) and
nothing else. Green release-tool tests say nothing about it either.

> ## Pressing **Mark as Active** is a STATE-CHANGING operation, even once
>
> It is not a read-only probe and must not be described as one. A single press can open an
> activation transaction, queue a `capture-and-activate` command addressed to the target device,
> and — if the capture and verification then succeed — **promote that device to active source**,
> demoting the previous one.
>
> **No one can guarantee that a fresh attempt will not switch the source.** Whether it does depends
> on what the target machine does next, which is outside the operator's control once the command is
> queued.
>
> A new live attempt therefore requires **separate explicit approval**, and should be made against
> an isolated test account and device wherever one exists — never against the working production
> source to "see what happens".

**Prefer evidence that already exists.** Nothing below needs a new attempt if a previous failure was
recorded.

---

## 1. First: look for an existing record (no new attempt)

In order of preference:

1. **Activity log** — the route writes `PROXY_DEVICE_MAKE_ACTIVE` on success, and the admin activity
   views carry prior admin actions with timestamps and device ids.
2. **The activation diagnostic** — `GET …/activation` returns the current or most recent transaction,
   including `failureCode`, `stage`, `activationId`, `targetDeviceId` and `stageAt`. Reading it
   changes nothing beyond persisting an already-expired transaction.
3. **A screenshot or copied error** from when the failure happened. The on-screen message carries the
   `code`, which is the single most useful field.
4. **Server logs** around that timestamp — the route logs `Proxy make-active error:` with a message
   for the `500` path.

If any of these gives a `code`, go to section 4. Do not press the button.

## 2. Export only these fields

| Field | Source |
|---|---|
| HTTP status | the `make-active` response |
| `code` | that response's JSON |
| `state` | that response's JSON, when present |
| `activationId` | either response, when present |
| `targetDeviceId` | either response |
| `failureCode`, `stage`, `stageAt` | `GET …/activation` |
| wall-clock time of the attempt | your own note |

**Do not export:** whole response payloads, HAR files, `Authorization` headers, cookies, CSRF
tokens, session identifiers, `deviceKey`/`keyHash`, DPAPI blobs, or any part of the captured
provider session. The seven fields above are sufficient; a HAR of an admin session is not a
diagnostic, it is a credential.

## 3. If a NEW attempt is approved

Only with separate explicit approval, and preferably on an isolated test account/device.

1. Note the wall-clock time and the exact `deviceId` you are about to target.
2. Record `GET …/activation` **before** pressing, so you can tell a new transaction from an old one.
3. Press **Mark as Active** once. Record the status and the fields in section 2.
4. Record `GET …/activation` again.
5. **Check status before pressing anything again** — see section 5.

## 4. Correlating the two reads — `/activation` may not describe your request

Some refusals happen **before `activation.create()` is ever called**. In those cases no transaction
exists for your attempt, so `GET …/activation` will return either `null` or **an earlier, different
transaction**, possibly for another device.

Rules:

- Treat `/activation` as describing your attempt **only if** its `activationId` matches the one in
  your `make-active` response, **or** (when no id was returned) its `targetDeviceId` matches the
  device you targeted **and** its `stageAt` is at or after your attempt's timestamp.
- If `activation` is `null`, that is consistent with a pre-create refusal. It is **not** evidence
  about your attempt either way.
- **Never attach an older `failureCode` to a new request.** A stale `ACCOUNT_MISMATCH` from last
  week explains nothing about today's `409`, and assuming it does is how the wrong fix gets shipped.

### The latched-`ERROR` trap

`canActivate()` admits only `READY` or `STANDBY`, and in `deviceState`'s precedence **`ERROR` and
`OFFLINE` outrank `READY`**. `ERROR` is set by `ACCOUNT_MISMATCH`, `PROMOTION_FAILED`,
`REPLAY_REJECTED`, `CANDIDATE_SCHEMA_INVALID` or `ROLLBACK_COMPLETED`.

So one earlier failure latches the device into `ERROR`, and **every later press is refused with
`DEVICE_ERROR` — a different code than the original failure**. If the captured code is
`DEVICE_ERROR`, the cause is in the *first* failure, and `/activation`'s `failureCode` is where it
was recorded. That is the one case where an older record is the relevant evidence — and it must be
identified as such, not silently substituted.

## 5. A failure response does NOT prove nothing was queued

Read from the route in `backend/routes/admin/proxyTools.js`. The boundary is `await account.save()`.

| Response | Persisted anything? |
|---|---|
| `404 No account` | **No** — nothing touched |
| `404 DEVICE_UNKNOWN` | **No** |
| `409 ALREADY_ACTIVE` | **No** |
| `409 DEVICE_<STATE>` | **No** |
| `409` from `validateTarget` (offline, no credential, superseded, version) | **No** |
| `409 Could not start the activation` | `activation.create()` already mutated the in-memory account, but **there is no save on this path**, so it is discarded |
| `400 Could not queue the capture command` | **YES** — `activation.fail()` then `await account.save()`. A **failed activation record is persisted** and will appear in `/activation` |
| `200` | Yes — activation saved, command attached and queued |
| `500` / `503 DB_BUSY` | **INDETERMINATE** — the throw may have occurred before or after either `await account.save()` |

Consequences for the operator:

- A `400` means a transaction **was** recorded. Do not read the next `/activation` as "nothing
  happened".
- A `500` or `503` means **unknown**. Read `/activation` and compare `activationId`/`stageAt` against
  your attempt before concluding anything, and before pressing again.
- **`503 DB_BUSY` is the one case where retrying is explicitly safe**, because that response is
  returned from the first `await` in the route, before any mutation. It is still a retry of a
  state-changing operation, so it needs the same approval as any other attempt.

## 6. What must not be done to obtain evidence

- No repeated presses, and no cycling between devices. A second attempt can move the device into a
  different state and destroy the evidence of the first.
- No **Sign out all**, no device revocation, no agent reinstall while gathering this.
- If an activation partially succeeded, the previous source keeps serving the stored session and
  must be left alone.

## 7. What is already ruled out

`requireActiveSource: false` is passed on this route, with the comment *"activating a non-active
device is the point"*. "The target must already be the active source" is **not** the cause, and no
change there is pending.
