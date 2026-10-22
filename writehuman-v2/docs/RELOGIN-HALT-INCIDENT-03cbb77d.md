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

   The owner's own helper agrees. `~/Downloads/Repair-WriteHuman-ReLogin.ps1` (17 Oct 2026) is the
   scripted operator path, and against this state it refuses three separate times before it would
   change anything - all three read from the agent's own `--workflow-status`:

   | Its check | Value in this incident | Result |
   |---|---|---|
   | `buildId -eq '3.5.13-captcha-rc1'` | `3.5.15-retry-rc1` | "Install the supplied 3.5.13 RC1 build first" |
   | `submissionUnresolved` (`credentialSubmitted && !closed`) | `true` | "A previous password submission is unresolved" |
   | `haltedReason -in ('captcha_required','mfa_required')` | `submission_outcome_unknown` | "Separate review required: submission_outcome_unknown" |

   So the halt was unresolvable from the agent, from the operator script, and across restarts.

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

---

## 9. CORRECTION (22 Oct 2026): "PROMOTED" was never proof of authentication

Section 5 above describes the resolution rule as acting on *"the backend's PROMOTED verdict on a
provider-verified candidate from this approved active source, i.e. proof the submission DID succeed
for the right account"*. **That premise is false**, and the rule as first written could clear a
security halt on evidence fully consistent with the password submission having failed. Traced
against the running backend (`main` ac29e45, which the release reconciliation establishes as the
live tree):

| Link | File | What it actually does |
|---|---|---|
| producer | `backend/utils/proxy/candidateSync.js:344` | `verifyAccountCookies(..., act ? {readOnly:true, canary:true} : {readOnly:true})` — the canary is requested on the **activation path only**; a routine push asks for none. |
| verifier | `backend/utils/proxy/verify.js:401` | with no canary it returns `{result:'working', httpStatus:200, finalPath:'/auth (jwt)'}` — a **local JWT decode**, with no `canary` field. A Supabase access token stays `exp`-valid for ~1 h *after* its session is gone. |
| producer | `backend/utils/proxy/candidateSync.js:387,521` | WriteHuman is `verifyMode 'supabase_refresh'`, so `canaryExpected` is true and a routine push records `canaryProven:false` / `canaryState:'absent'`. The producer **knows** the proof is absent. |
| route | `backend/routes/proxy/agentSync.js` | the reply forwarded `code/changed/promoted/standby/bundleVersion/activeSource` + directives — and **not** `canaryProven`/`canaryState`. |

So `verified = PROMOTED && promoted && isActiveSource && !standDown` is satisfiable with zero fresh
provider proof — and a signed-out source browser is exactly the state a `submission_outcome_unknown`
halt exists to protect against. The comment in `pushIfChangedInner` claiming acceptance "means
candidateSync completed its provider-authenticated verify AND its expectedAccountId match" was
likewise wrong for routine pushes, and has been corrected in place.

### What changed

- **The halt is cleared only on server-stated, fresh, correlated proof** (`evaluateAuthProof`):
  `canary === 'passed'`, dated, newer than `haltedAt`, same source device, same candidate revision,
  within two scheduler cadences. The gate lives in `noteReloginVerdict` — the *single writer* of
  `haltedReason` — so no caller can bypass it.
- **Routine cookie-sync acceptance is unchanged.** No provider round-trip was added to the push
  path; that was the 2026-10-19 regression and it is not reintroduced. The proof reused is the one
  `cron/proxyVerifyScheduler.js` already produces out of the request path every ~7 min.
- **Smallest compatible contract correction** (additive, optional, older agents ignore it):
  `verifyAndApply` and `candidateSync` now record *how* a session was proven (`verification.canary`),
  and `agentSync` forwards it as `sessionProof`. No second verifier, no new polling, and the client
  never asserts its own verification.
- **Honesty.** Proven *current* authentication resolves the *uncertainty*; it does not retroactively
  show the original submission succeeded. The record keeps `credentialSubmitted`, the attempt
  budget and the incident history, and adds `resolvedBy:'current_auth_proof'`,
  `submissionOutcome:'unknown'`, `lastSubmissionOutcome:'unknown_resolved_by_current_auth_proof'`.
- **`EXPECTED_AGENT_VERSION` reverted to `3.5.15`.** Bumping it to 3.5.16 made the dashboard
  advertise "update available → 3.5.16" for every live agent, pointing at a download that does not
  exist. The compatibility floors (`MIN_AGENT_VERSION` 3.4.0, `MIN_ACTIVATION_AGENT_VERSION` 3.5.0)
  were never touched.

### Known limitation — needs a decision

A routine promotion installs **new** cookies, so it correctly records the new bundle as unproven
(`canary: null`); the scheduler proves it within ~7 min, but that proof then arrives *between*
pushes. Because `sessionProof` is only carried on the candidate-push reply, and because a HEARTBEAT
must never be treated as authentication proof, **auto-resolution in practice requires a
canary-proven promotion (the activation path)**. A routine promotion will not clear the halt.
Carrying `sessionProof` on the heartbeat reply as well would close that gap — the proof would still
be the server's canary, correlated to a bundle revision, never the heartbeat itself — but that is a
contract decision, not a defect fix, and is **not** done here. Until it is decided, the sanctioned
route for the affected installation is the operator path, which is proposed for approval and
deliberately not implemented in this branch.

### Tests

`backend/tests/writehumanAgentHaltProofContract.test.js` — 12 tests. Part C drives the **real**
Express router and the **real** `candidateSync`, stubbing only the provider boundary, so the
PROMOTED reply under test is produced by the server rather than hand-built. Part B drives the real
`resolveHaltOnVerifiedPromotion` against a real state file. The old `B5` source-pattern test, which
asserted the literal text of the unsound `verified` expression, is replaced by behaviour.
