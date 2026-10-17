# Mark as Active — minimal evidence capture

**Status of the original incident: NOT DIAGNOSED.** No failed request from it has been captured, so
there is no root cause in this document and none should be inferred from anything else in this
branch.

In particular, the `DB_BUSY` change on this route is **not** a fix for that incident. It corrects
how a *database-saturation* failure is reported (`503 + Retry-After` instead of a generic `500`)
and nothing else. Green release-tool tests say nothing about it either. The incident remains open.

This page is one capture procedure. It is deliberately not an audit.

---

## What is needed

Five fields from **one** failing attempt:

| Field | Where |
|---|---|
| HTTP status | the `POST …/make-active` response |
| `code` and `state` | that response's JSON body |
| `failureCode` / `stage` | `GET …/activation` immediately afterwards |
| `activationId` | either response — correlates the two |
| timestamp (`stageAt`) | `GET …/activation` |

All of these are already sanitized. `activation.publicView()` is covered by tests asserting it
never carries a nonce, cookie, `deviceKey`, `keyHash`, password or vault blob, so the output below
is safe to paste into an issue.

## Procedure

1. Sign in to the admin dashboard as usual. **Change nothing.**
2. Open DevTools ▸ Network, filter on `make-active`.
3. Press **Mark as Active** on the device that fails — **once**. Do not retry, and do not try a
   different device: a second attempt can change the state you are trying to observe.
4. On the `POST …/devices/<deviceId>/make-active` row, record the **Status** and copy the
   **Response** body.
5. Immediately open, in the same session:

   ```
   GET /api/crm/admin/proxy-tools/writehuman/activation
   ```

   and copy the whole JSON. It is read-only; it changes nothing beyond persisting an already-expired
   transaction.
6. Paste both payloads. Nothing needs redacting, but check for an `email` field and mask it if the
   masked form is not already used.

## Safety

- **One attempt.** The failure is what is being measured; repeating it can move the device into a
  different state and destroy the evidence.
- **No live source switching to reproduce.** If the activation partially succeeded, the previous
  source keeps serving and must be left alone.
- Do not use **Sign out all**, do not revoke a device, and do not reinstall the agent while
  gathering this.

## Why the cause cannot be guessed from the code

`POST …/make-active` has four distinct refusal points, each with its own code and its own fix. They
are not interchangeable, and three of them are the identity and replay protections that must not be
weakened:

| Code | Gate |
|---|---|
| `ALREADY_ACTIVE` | the device is already the active source |
| `DEVICE_<STATE>` | `canActivate()` admits only `READY` or `STANDBY`. **`ERROR` and `OFFLINE` outrank `READY`**, so one earlier failure (`ACCOUNT_MISMATCH`, `PROMOTION_FAILED`, `REPLAY_REJECTED`, `CANDIDATE_SCHEMA_INVALID`, `ROLLBACK_COMPLETED`) latches the device into `ERROR` and every later attempt is refused with a *different* code than the first |
| `ACTIVATION_VERSION_UNSUPPORTED` | agent older than `MIN_ACTIVATION_AGENT_VERSION` (3.5.0) |
| `DEVICE_OFFLINE` / `DEVICE_NO_CREDENTIAL` / `DEVICE_SUPERSEDED` | addressability |

The latched-`ERROR` path is the one worth noting when reading the capture: if the first failure and
the one being reported now carry different codes, the original cause is in the **first** failure,
and `GET …/activation`'s `failureCode` is where it is recorded.

`requireActiveSource: false` is already passed on this route (`proxyTools.js`, with the comment
*"activating a non-active device is the point"*), so "the target must already be active" is not the
cause and no change there is pending.
