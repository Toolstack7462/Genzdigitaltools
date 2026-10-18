// Builds a BROWSER FIXTURE of the redesigned Zee, in every state, from the real components and the
// real stylesheets.
//
// WHAT THIS IS. The panel and launcher are server-rendered with react-dom/server against synthetic
// client state, and the output is written to one standalone HTML file with clientAssistant.css and
// genzAvatar.css inlined. frontend/scripts/zee-redesign-capture.cjs then loads that file in real
// Chromium, measures each state and saves screenshots at desktop and phone widths.
//
// WHAT THIS IS NOT. It is evidence about MARKUP, CSS and measured geometry. It is not a live React
// interaction (SSR output has no runtime), not an authenticated session, and not acceptance of the
// support handoff or any API behaviour. Those stay separate and unrun.
import fs from 'fs';
import os from 'os';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let mockGuide;
jest.mock('../ClientGuideProvider', () => ({
  __esModule: true,
  useClientGuide: () => mockGuide,
  default: ({ children }) => children,
}));

// eslint-disable-next-line import/first
import ClientGuidePanel from '../ClientGuidePanel';
// eslint-disable-next-line import/first
import ClientGuideLauncher from '../ClientGuideLauncher';

export const OUT_DIR = path.join(os.tmpdir(), 'zee-redesign');
const OUT = path.join(OUT_DIR, 'zee-redesign.html');

const FLOW = {
  code: 'EXTENSION_DISCONNECTED',
  title: 'Reconnect the extension',
  avatar: 'warning',
  steps: [
    { text: 'Open the extension from your browser toolbar and sign in again. I’ll wait here.', action: 'recheck-extension' },
    { text: 'If it still can’t be detected, the setup guide has the install steps.', action: 'navigate:/client/extension-guide' },
    { text: 'Still stuck? A human can take it from here.', action: 'support' },
  ],
  support: true,
  retryable: true,
  ctx: { toolName: 'StealthWriter' },
};

const base = (over = {}) => ({
  open: true,
  openAssistant: () => {}, closeAssistant: () => {},
  prompt: null, dismissPrompt: () => {},
  startIssueByCode: () => {}, startIntent: () => {}, handleFreeText: () => {},
  performAction: () => {}, resetConversation: () => {}, setAvatarState: () => {},
  avatarState: 'greeting', returnFocusToken: 0,
  history: [], flow: null,
  client: { firstName: 'Sam', fullName: 'Sam Client', email: 'sam@example.com' },
  extensionStatus: null,
  // Fields the redesigned panel reads:
  extensionKind: 'unknown', lastIssueCode: null,
  stepIndex: 0, stepCount: 0, nextStep: () => {}, prevStep: () => {},
  draft: '', setDraft: () => {},
  ...over,
});

const STATES = {
  welcome: base(),
  chat: base({
    avatarState: 'thinking',
    history: [
      { role: 'client', text: 'mera tool open nahi ho raha' },
      { role: 'guide', text: 'Reconnect the extension' },
    ],
    flow: FLOW, stepIndex: 0, stepCount: FLOW.steps.length,
    extensionKind: 'disconnected', lastIssueCode: 'EXTENSION_DISCONNECTED',
  }),
  chatStep2: base({
    avatarState: 'speaking',
    history: [
      { role: 'client', text: 'mera tool open nahi ho raha' },
      { role: 'guide', text: 'Reconnect the extension' },
      { role: 'client', text: 'ab bhi nahi chal raha' },
    ],
    flow: FLOW, stepIndex: 1, stepCount: FLOW.steps.length,
    extensionKind: 'disconnected', lastIssueCode: 'EXTENSION_DISCONNECTED',
    draft: 'dusra tool bhi',
  }),
};

test('builds a multi-state Chromium fixture of the redesigned Zee', () => {
  const here = path.join(__dirname, '..');
  const css = [
    fs.readFileSync(path.join(here, 'clientAssistant.css'), 'utf8'),
    fs.readFileSync(path.join(here, '..', 'genzAvatar', 'genzAvatar.css'), 'utf8'),
  ].join('\n');

  const rendered = {};
  for (const [name, st] of Object.entries(STATES)) {
    mockGuide = st;
    rendered[name] = renderToStaticMarkup(React.createElement(ClientGuidePanel));
    expect(rendered[name]).toContain('cga-panel');
  }

  // The welcome state must carry the hero and the chips; the chat state must not.
  expect(rendered.welcome).toContain('cga-hero');
  expect(rendered.welcome).toContain('cga-chip');
  expect(rendered.welcome).toContain('cga-morelink');
  expect(rendered.chat).not.toContain('cga-hero');
  expect(rendered.chat).toContain('cga-stepcard');
  expect(rendered.chat).toContain('Step 1 of 3');
  expect(rendered.chatStep2).toContain('Step 2 of 3');

  mockGuide = base({ open: false });
  const launcher = renderToStaticMarkup(React.createElement(ClientGuideLauncher));
  expect(launcher).toContain('cga-launcher');

  // Each state is isolated in its own positioning context so the panel's fixed/absolute CSS lays
  // out inside the cell rather than over the page, which is what makes geometry measurable.
  const cell = (id, label, markup) => `
    <section class="cell" id="cell-${id}">
      <p class="label">${label}</p>
      <div class="stage" id="stage-${id}">${markup}</div>
    </section>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zee — redesigned states</title>
<style>
  :root { --genz-navy:#071B33; --genz-blue:#2563EB; --genz-cyan:#06B6D4; --genz-teal:#0E9F9A;
          --genz-muted:#5B6B7C; --genz-success:#16A34A; --genz-border:#E2E8F0; --genz-bg:#F7FAFC; }
  * { box-sizing: border-box; }
  body { margin:0; background:#EEF3F8; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .wrap { display:flex; flex-wrap:wrap; gap:28px; padding:28px; align-items:flex-start; }
  .cell { width:336px; }
  .label { margin:0 0 8px; font-size:11px; font-weight:700; letter-spacing:.6px;
           text-transform:uppercase; color:#5B6B7C; }
  /* The stage is the positioning context for the panel's own CSS. */
  .stage { position:relative; width:336px; min-height:540px; }
  .stage .cga-panel { position:absolute; right:0; bottom:0; }
  #launcher-stage { position:relative; width:120px; height:120px; }
  /* A FULL-WIDTH stage: the mobile sheet rule is width:100% of its containing block, so measuring
     it inside a 336px cell would understate it. This stage spans the viewport. */
  /* Full-bleed: cancels .wrap's 28px padding so the stage really is the viewport width. In the
     app the panel is position:fixed against the viewport, so a padded stage would understate it. */
  #mobile-stage { position:relative; width:calc(100% + 56px); margin:0 -28px; min-height:620px; }
  #mobile-stage .cga-panel { position:absolute; left:0; right:0; bottom:0; }
  #launcher-stage .cga-launcher-wrap { position:absolute; right:8px; bottom:8px; }
  .hidden { display:none; }
${css}
</style></head>
<body>
  <div class="wrap">
    ${cell('welcome', 'Desktop · welcome', rendered.welcome)}
    ${cell('chat', 'Desktop · conversation, step 1', rendered.chat)}
    ${cell('chat2', 'Desktop · step 2 + draft', rendered.chatStep2)}
    <section class="cell" style="width:120px">
      <p class="label">Launcher</p>
      <div id="launcher-stage">${launcher}</div>
    </section>
    <section class="cell" style="width:100%">
      <p class="label">Sheet in a full-width stage (mobile measurement)</p>
      <div id="mobile-stage">${rendered.chat}</div>
    </section>
  </div>
</body></html>`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, html, 'utf8');
  expect(fs.existsSync(OUT)).toBe(true);
  // Loud, so the capture script's input path is never guessed.
  // eslint-disable-next-line no-console
  console.log('[zee-redesign-fixture] ' + OUT);
});
