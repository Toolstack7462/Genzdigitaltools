# Rendered-browser verification (manual, not a CI gate)

`verifyAutoSyncPanel.js` drives **real Chrome** against the **real built bundle** and asserts the
Admin → WriteHuman layout in a live DOM — not by reading source order:

* exactly **one** Extension Credential Auto-Sync panel exists;
* it renders **before** the Live logs section (`compareDocumentPosition`);
* it survives a failed policy read (HTTP 500), target ambiguity, disabled and observe states —
  the section is never removed and never shows fabricated empty settings;
* the existing controls appear in their correct states — Refresh Status, Enable (Observe),
  Pause / Disable, Approve this account, Switch to Enforce, Back to Observe, Save target,
  Clear selection.

The API is intercepted with `page.route`, so **no production data, credential or session is
involved** and nothing is written anywhere.

## Why this is not in CI

It needs Playwright and a browser, which are **not** dependencies of this repo. Adding them to the
frontend dependency tree is a separate decision, so this stays a manual instrument and the CI guard
remains the source-contract test in
`src/pages/admin/__tests__/autoSyncPanelPlacement.test.js`. That test is explicitly labelled
source-level; this file is what produces rendered-browser evidence.

## Run

```sh
mkdir -p /tmp/pw && cd /tmp/pw && npm init -y && npm i playwright   # once, outside the repo
cd <repo>/frontend && npm run build
node e2e/serveBuild.js build 4191 &
node --require /tmp/pw/node_modules/playwright <this dir>/verifyAutoSyncPanel.js . synced
# modes: synced | error | ambiguous | observe | disabled | canenforce
```

Each run prints a JSON report and writes `panel-<mode>.png` (full page).

## Verified 2026-10-20 against build `main.57da41a2.js`

| mode | panels | order | controls rendered |
|---|---|---|---|
| synced | 1 | panel-before-livelogs | Refresh, Pause/Disable, Back to Observe, Save target, Clear selection |
| error (500) | 1 | panel-before-livelogs | Refresh + visible error; panel NOT removed |
| ambiguous | 1 | panel-before-livelogs | Refresh, Pause/Disable, Back to Observe, Save target |
| observe (awaiting approval) | 1 | panel-before-livelogs | Refresh, Pause/Disable, **Approve this account**, Save target, Clear selection |
| disabled | 1 | panel-before-livelogs | Refresh, **Enable (Observe)**, Save target, Clear selection |
| canenforce | 1 | panel-before-livelogs | Refresh, Pause/Disable, **Switch to Enforce**, Save target, Clear selection |

Heading order observed in Chrome: `… System / health → Health alerts → Actions →
Extension Credential Auto-Sync → Live logs`. Zero console errors except the deliberate 500.
