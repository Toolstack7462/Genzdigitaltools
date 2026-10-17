# Gen Z Guide — Client Support Assistant

Context-aware, animated support assistant for the **authenticated client portal**. It helps logged-in
clients use their tools, diagnose access problems, install/update the extension, understand plan/
expiry, recover from errors with step-by-step guidance, retry safely, and escalate to WhatsApp
support. It is **not** a generic chatbot — guidance is deterministic and derived from the client's
real portal state and the codes this project already returns. **No AI API is used.**

## Where it renders
Mounted once, in `frontend/src/components/ClientLayoutEnhanced.js` (the shared authenticated client
layout). That layout wraps only the authenticated client pages (`/client/dashboard`, `/client/tools`,
`/client/tools/:id`, `/client/profile`, `/client/activity`, `/client/extension-guide`,
`/client/stealthwriter`). It therefore **never** renders on public marketing routes, the homepage,
`/client/login`, signup/reset pages, or admin routes. A source-level guard test
(`features/clientAssistant/__tests__/renderScope.test.js`) enforces this.

## Architecture
`frontend/src/features/clientAssistant/`
- `ClientGuideProvider.js` — state + API (`openAssistant`, `closeAssistant`, `startIntent`,
  `startIssueByCode`, `handleFreeText`, `performAction`, `resetConversation`, `setAvatarState`);
  subscribes to the `reportIssue()` bus; reuses `useExtension()`, `authService` cached user,
  react-router navigation, and `lib/support`.
- `ClientGuideLauncher.js` — floating launcher + dismissible, non-blocking help prompt.
- `ClientGuidePanel.js` — accessible dialog (lazy-loaded chunk): avatar, welcome, history, quick
  actions, step-by-step flow, retry/support, free-text, Start over.
- `ClientGuideAssistant.js` — composition + narrow error boundary (renders nothing on failure) +
  lazy panel gate. **This is the only thing the layout imports.**
- `AvatarRenderer.js` — library-agnostic avatar adapter with a non-AGPL CSS/lucide fallback.
- `assistantIntents.js` — deterministic EN + Roman-Urdu intent matcher.
- `diagnosticFlows.js` — issue codes, code normalisation, ordered diagnosis, flow definitions.
- `avatarStates.js` — semantic → avatar-key mapping with safe fallback.
- `assistantEvents.js` — `reportIssue()` bus, auto-open-once gate, safe non-sensitive logging.
- `supportHandoff.js` — safe support message via the central `lib/support` helper.
- `clientAssistant.css` — scoped `cga-*` styles using brand tokens.
- `assets/README.md` — how to add a real `.avatar.json` later.

## Supported issue codes (canonical)
`TOOL_NOT_ASSIGNED, ASSIGNMENT_INACTIVE, ASSIGNMENT_EXPIRED, SUBSCRIPTION_EXPIRED, EXTENSION_MISSING,
EXTENSION_OUTDATED, EXTENSION_DISCONNECTED, TOOL_LAUNCH_FAILED, SESSION_EXPIRED, NETWORK_ERROR,
SERVER_ERROR, UNKNOWN_CLIENT_ISSUE`.

`normalizeIssueCode()` maps the **real** repo codes onto these, e.g. `assignment_expired →
ASSIGNMENT_EXPIRED`, `extension_not_detected → EXTENSION_MISSING`, `extension_update_required →
EXTENSION_OUTDATED`, `extension_token_invalid → SESSION_EXPIRED`, `tool_domain_invalid /
no_active_session → TOOL_LAUNCH_FAILED`. Unknowns → `UNKNOWN_CLIENT_ISSUE`.

## Troubleshooting flows
Each flow provides client-friendly, step-by-step guidance with actions mapped to **real** existing
behaviour: `navigate:/client/tools`, `navigate:/client/extension-guide`, `renew` (central renewal
WhatsApp), `recheck-extension` (`useExtension().reconnect()`), `retry` (the issue's own safe retry
or `useExtension().openTool`), `support` (central WhatsApp handoff). The "tool not opening" flow runs
`diagnoseToolNotOpening()` over real state in a safe order: assigned → active → not expired →
extension present/current/connected → launch error code.

## Calling `reportIssue()` from other components
```js
import { reportIssue } from 'features/clientAssistant/assistantEvents';
reportIssue({
  code: 'TOOL_LAUNCH_FAILED', // or a raw repo code — it is normalised
  source: 'tool_launch',      // omit 'background' to allow one auto-open
  toolId, toolName,
  recoverable: true,
  retry: () => openTool(toolId), // optional safe retry (kept in memory only)
});
```
Only `code, source, toolId, toolName, message, recoverable, retry` cross the bus (everything else is
stripped). Already wired into the dashboard's tool-launch-failure path. The assistant auto-opens at
most **once per unique `code:tool` per browser session** (tracked in `sessionStorage`, UI-state
only); otherwise it shows a dismissible prompt. Background (non-client-initiated) issues never
auto-open.

## Avatar state mapping
App → semantic states: `idle, greeting, listening, thinking, speaking, success, warning, error`.
`avatarStates.resolveAvatarKeys(semantic, definition)` resolves to concrete expression/animation
keys **that exist** in the supplied `.avatar.json`, falling back to `neutral`/`idle` (or any valid
key, or the CSS fallback) when a key or the whole definition is absent. Flow hints
(`neutral/listening/thinking/happy/warning/sad/confused`) map to semantic states via
`flowHintToSemantic()`.

## Avatar asset replacement
See `features/clientAssistant/assets/README.md`. Save the exported file at
`features/clientAssistant/assets/genz-guide.avatar.json` and pass a `renderer` adapter + parsed
`definition` to `AvatarRenderer`.

## Package & licence
- Reference runtime: `@bible-strong/avatar-react` (npm `0.1.0`, pre-1.0), **AGPL-3.0**.
- **Not installed / not bundled.** No documented AGPL approval exists in this repo.
- **Blocker:** bundling the AGPL runtime into the production frontend requires a documented licence
  decision (AGPL compliance, a commercial licence, or written permission) and preserving its
  copyright/licence notices. Until then the assistant uses the non-AGPL CSS/lucide fallback, which
  is fully functional. One documented integration point exists (`AvatarRenderer`'s `renderer` prop).

## Accessibility
Keyboard-operable launcher and controls; visible focus (`:focus-visible`); `Escape` closes; focus
moves to the panel's close button on open; `role="dialog"` + `aria-label`; `aria-live="polite"`
message region; real `<button>`/`<form>` elements; 44px touch targets; `prefers-reduced-motion`
respected (JS + CSS); animation pauses when the tab is hidden; brand-token contrast; no autoplay
audio; no `dangerouslySetInnerHTML`.

## Security constraints
Never renders or logs credentials, tokens, cookies, lease tokens, or full authenticated payloads.
`reportIssue` strips to a safe field whitelist; support messages include only name/email/tool/issue
via the central `lib/support` helper (no second hard-coded number). Only non-sensitive UI state is
kept in `sessionStorage`.

## Testing
Pure-logic + structural tests (project uses Jest via `craco test`; RTL is not installed):
```
cd frontend && CI=true npx craco test --watchAll=false --testPathPattern="features/clientAssistant"
```
Covers: intent matching, issue normalisation + ordered diagnosis + flow safety, avatar
semantic/fallback + unknown-key, support URL, auto-open-once, event sanitisation, and the
render-scope boundary (public/admin/login).

## Known limitations
- Rich animated avatar is gated on the AGPL licence decision (CSS fallback used meanwhile).
- Free-text uses a deterministic matcher (no AI); unmatched input shows options + support.
- Component-render tests are source-level guards because RTL is not part of this project.
