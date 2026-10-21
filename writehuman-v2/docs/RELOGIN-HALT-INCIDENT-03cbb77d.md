# Agent re-login dead end - incident 03cbb77d-2105-49a2-bb09-6366f1141495

20 Oct 2026. The installed WriteHuman Agent 3.5.15 stopped signing its own source account back in.
This records what was measured, what the defect actually was, what was deliberately left alone, and
what is still owed before anything ships.

## 1. What was observed

`agent-relogin.json` held `haltedReason = "submission_outcome_unknown"`, and from then on every
recovery attempt logged:

    recovery_transition  stage=RECOVERY_BLOCKED  event=MANUAL_INTERVENTION_REQUIRED
                         reason=halted_submission_outcome_unknown  manual_required=true

No cookie, password, token or page content was read to establish this - only the recovery state
machine's own sanitised fields.

## 2. Source identified by hash, not by version string

Matching version strings are not byte identity, and `release/agent-3.5.15` carries OLDER 3.5.2
source. The build that produced the diagnostics corresponds to:

| Branch | `writehuman-v2/agent/cookie-sync-agent.js` (git blob, LF) |
|---|---|
| `candidate/writehuman-3.5.15-integration` | `0dacfd686af9f67c58e47e774de8ef5a4d29c8e6fed6ad53a0cf9b0952fd2431` |
| `release/agent-3.5.15`, `main`, others | `4382905550cafdc8...` (older bytes) |

Everything below was read from, and tested against, the first of those.

## 3. The halt itself is correct

`finish('submission_outcome_unknown')` is written when a password was submitted and the outcome
could not be observed. A machine must not then send another password blindly, so halting is a
legitimate safety requirement - not the defect. `submission_outcome_unknown` is in
`RELOGIN_TERMINAL` for that reason.

## 4. The defect: nothing could ever resolve it

Three separate things had to be true at once, and they were:

1. **Confirmation kept the halt.** `noteReloginVerdict('confirmed')` - the backend's PROMOTED
   verdict on a provider-verified candidate from this approved active source, i.e. positive proof
   that the submission DID succeed, for the right account - closed the incident
   (`closed:true`, stage `SYNC_RESUMED`) but wrote `haltedReason: terminal ? verdict :
   cur.haltedReason`, keeping it. The eligibility gate refuses on `haltedReason` alone:

       if (st.haltedReason) return blocked('halted_' + st.haltedReason);

2. **That confirmation was unreachable anyway.** The push handler records a verdict only inside
   `if (state.reloginPending)`, an IN-MEMORY flag which the terminal `finish()` had already set
   false; the durable `pendingVerification` was written false too, so no restart could re-arm it.
   The process that saves the halt is therefore the only one that could resolve it, and after
   saving it, it no longer can.

3. **No operator command covered it.** `--acknowledge-resolved-challenge` refuses anything but
   `captcha_required` / `mfa_required` (`security_review_required`), and additionally refuses while
   a submitted credential is unresolved; `recheckStaleCaptchaHalt` is CAPTCHA-only; and
   `--authorize-session-limit-recovery` writes `config.json`, never the halt. There was no
   supported action, so the install was blocked for its remaining life.

## 5. The correction

Agent source only, `writehuman-v2/agent/cookie-sync-agent.js`, two small changes:

* `noteReloginVerdict` - a `confirmed` verdict clears **only** a `submission_outcome_unknown`
  halt, because that halt records exactly the fact the verdict establishes. Every other terminal
  halt (wrong credentials, wrong account, CAPTCHA, MFA, rate limit, account restriction, each
  session-limit halt) survives and keeps its existing review. An unreadable state file stays a
  sentinel.
* the accepted-push path - the same verdict is applied when a candidate is VERIFIED
  (`PROMOTED` + `promoted` + `isActiveSource` + not stood down) and this process holds no pending
  recovery, which is what makes the resolution reachable after the halt and across restarts.

Deliberately NOT done: no timeout raised, no state file deleted or rewritten by hand, no budget
reset, no identity check weakened, no `credentialSubmitted` falsified, and the pre-submit
unknown-submission guard is untouched. Retry budgets (3/hour, 20-minute cooldown) are preserved, so
the first thing the fixed agent hits after resolution is an ordinary time-bounded block.

## 6. Tests

`backend/tests/writehumanAgentReloginHaltResolution.test.js`, in `npm test` and `npm run test:ci`.
Nine tests drive the real exported functions against a throwaway state file - no browser, no
network, no credential.

Against the shipped 3.5.15 source: **6 pass, 3 fail** (A2, A4, B5 - the reproducer).
With the correction: **9 pass**. Whole backend suite: 889/895, the same 4 pre-existing Windows-only
failures as the untouched branch (committed frontend build freshness, git-restore semantics, and
two spawned-checker crashes, exit 0xC0000409).

## 7. Version, and what is still owed

The corrected source is **3.5.16**, not 3.5.15: it is different bytes and must not be passed off as
the published release. `EXPECTED_AGENT_VERSION` moves with it, per
`writehumanAgentVersionDrift.test.js`.

Consequences the owner needs to decide on, in order:

1. **3.5.15 stays installed and published.** Nothing here rebuilds or republishes the installer.
2. Until `node writehuman-v2/agent/build-installer.mjs` is run and `dist/` published,
   `npm run test:release-gate` will FAIL and the admin page will advertise 3.5.16 with nothing to
   download. That is the designed artifact guard (the 2026-08-26 drift), working as intended.
3. **Live acceptance is still owed**: the end-to-end path (real Chrome, a real halt, a real
   PROMOTED candidate) cannot run in a unit test. B5 pins the reachability contract in source only.
4. **The already-halted installation is not touched by this change.** On the machine that hit the
   incident, the saved halt lifts only when that agent is updated AND a verified candidate is
   promoted again. A stuck install with no promotable candidate still has no operator command -
   adding one (an explicit, logged acknowledgement for this halt class) is a separate decision, not
   taken here.

## 8. Local-machine note

The machine inspected during this investigation (`NOUMAN-ALI6`) is NOT the agent that produced the
diagnostics: it has 3.5.0 installed (2026-08-29), no running process, and a stale `agent.lock`
(2026-09-02). The 3.5.15 install lives elsewhere, so no live state was altered.
