// Builds a BROWSER FIXTURE from the real Zee components and the real stylesheets.
//
// WHAT THIS IS. The components are server-rendered with react-dom/server against a synthetic
// client state, and the output is written to a standalone HTML file with clientAssistant.css and
// genzAvatar.css inlined. frontend/scripts/zee-browser-acceptance.cjs then loads that file in
// Chromium and measures layout, reduced motion and the support link.
//
// WHAT THIS IS NOT. It is fixture-based evidence about MARKUP AND CSS. It is not live staging
// authorization (no authenticated session, no router, no real API), and it is not screen-reader
// acceptance (no assistive technology is involved). Those stay unrun; see
// writehuman-v2/docs/ACCEPTANCE-CHECKS.md rows C4 and C6.
import fs from 'fs';
import os from 'os';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Synthetic client state: a plausible authenticated client with an actionable issue, so the panel
// renders its flow, its quick actions and a support affordance.
let mockGuide;
jest.mock('../ClientGuideProvider', () => ({
  __esModule: true,
  useClientGuide: () => mockGuide,
  default: ({ children }) => children,
}));

// eslint-disable-next-line import/first
import ClientGuideLauncher from '../ClientGuideLauncher';
// eslint-disable-next-line import/first
import ClientGuidePanel from '../ClientGuidePanel';
// eslint-disable-next-line import/first
import { buildAssistantSupportUrl } from '../supportHandoff';

const OUT_DIR = path.join(os.tmpdir(), 'zee-fixture');
const OUT = path.join(OUT_DIR, 'zee-fixture.html');

const state = (over = {}) => ({
  open: false,
  openAssistant: () => {},
  closeAssistant: () => {},
  prompt: null,
  dismissPrompt: () => {},
  startIssueByCode: () => {},
  startIntent: () => {},
  handleFreeText: () => {},
  performAction: () => {},
  resetConversation: () => {},
  setAvatarState: () => {},
  avatarState: 'idle',
  returnFocusToken: 0,
  history: [{ role: 'guide', text: 'Your tool did not open' }],
  flow: {
    code: 'TOOL_LAUNCH_FAILED',
    title: 'Your tool did not open',
    avatar: 'warning',
    steps: [
      { text: 'Check that the extension is connected.', action: 'recheck-extension' },
      { text: 'Open the Extension Setup Guide.', action: 'navigate:/client/extension-guide' },
      { text: 'Still stuck? Contact support.', action: 'support' },
    ],
    support: true,
    retryable: true,
    ctx: { toolName: 'StealthWriter' },
  },
  client: { firstName: 'Sam', fullName: 'Sam Client', email: 'sam@example.com' },
  extensionStatus: { installed: true, connected: true },
  ...over,
});

test('builds a Chromium fixture from the real components and stylesheets', () => {
  const here = path.join(__dirname, '..');
  const css = [
    fs.readFileSync(path.join(here, 'clientAssistant.css'), 'utf8'),
    fs.readFileSync(path.join(here, '..', 'genzAvatar', 'genzAvatar.css'), 'utf8'),
  ].join('\n');

  mockGuide = state({ open: false });
  const launcher = renderToStaticMarkup(React.createElement(ClientGuideLauncher));
  mockGuide = state({ open: true });
  const panel = renderToStaticMarkup(React.createElement(ClientGuidePanel));

  expect(launcher).toContain('cga-launcher');
  expect(panel).toContain('cga-panel');

  // A stand-in for the client page behind the assistant: a fixed sidebar and a wide table, so the
  // launcher's position and any horizontal overflow are measurable.
  const supportUrl = buildAssistantSupportUrl({
    issueTitle: 'Your tool did not open', toolName: 'StealthWriter',
    clientName: 'Sam Client', clientEmail: 'sam@example.com',
  });

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zee fixture</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  body{margin:0;font-family:system-ui,sans-serif;background:#F8FAFC}
  .host-nav{position:fixed;left:0;top:0;bottom:0;width:240px;background:#071B33;color:#fff;z-index:40}
  .host-main{margin-left:240px;padding:16px}
  .host-wide{width:100%;max-width:100%;overflow-x:auto}
  @media (max-width:640px){ .host-nav{width:100%;height:56px;bottom:auto} .host-main{margin-left:0;padding-top:72px} }
${css}
</style></head>
<body>
  <nav class="host-nav" data-testid="host-nav">client navigation</nav>
  <main class="host-main"><div class="host-wide"><p>client dashboard content</p></div></main>
  <div id="zee-launcher">${launcher}</div>
  <div id="zee-panel">${panel}</div>
  <a id="support-probe" href="${supportUrl}">support</a>
</body></html>`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, html, 'utf8');

  // The support URL must already be safe: the fixture is a file an engineer will open by hand.
  expect(supportUrl.startsWith('https://wa.me/')).toBe(true);
  for (const secret of ['sb-', 'auth-token', 'Bearer', 'deviceKey', 'keyHash', 'csrf']) {
    expect(supportUrl).not.toContain(secret);
  }
  expect(fs.existsSync(OUT)).toBe(true);
});
