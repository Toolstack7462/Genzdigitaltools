/**
 * ZEE MUST NOT BE A SECOND LAUNCH OWNER.
 *
 * The dashboard owns a launch attempt through lib/launchAttempts: it decides which attempt may
 * write the card, and it cancels an older attempt's clear-timer. Zee's `retry` action had a
 * fallback that called `ext.openTool(c.toolId)` directly whenever the raiser had not registered a
 * retry function. That is a second owner for the same launch: the card that reported the failure
 * never learns the outcome, so it keeps its red banner while the tool actually opens, and a stale
 * clear-timer can wipe freshly-set state.
 *
 * These render the REAL provider against a spied extension hook. The first test fails against the
 * direct-openTool fallback.
 */
/* eslint-env jest */
// react-dom/client + act directly, as hooks/__tests__/extensionOwner.test.js does. No new
// dependency is introduced for this.
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

global.IS_REACT_ACT_ENVIRONMENT = true;

let mockExt;
const mockNavigate = jest.fn();

jest.mock('../../../hooks/useExtension', () => ({ __esModule: true, useExtension: () => mockExt }));
// react-router-dom v7 ships an ESM exports map that jest cannot resolve from here, which is why
// every other test in this folder mocks the provider away instead of rendering it. A virtual mock
// supplies just the one hook the provider uses, so the REAL provider can be rendered.
jest.mock('react-router-dom', () => ({ __esModule: true, useNavigate: () => mockNavigate }), { virtual: true });
jest.mock('../../../services/authService', () => ({
  __esModule: true,
  authService: { getClientUser: () => ({ id: 'client-1', fullName: 'Sam Client', email: 'sam@example.test' }) },
}));

// eslint-disable-next-line import/first
import { ClientGuideProvider, useClientGuide } from '../ClientGuideProvider';

let ctx;
let roots = [];
function Probe() { ctx = useClientGuide(); return React.createElement('div', { 'data-testid': 'probe' }); }

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(React.createElement(ClientGuideProvider, null, React.createElement(Probe))); });
  const entry = { container, unmount: () => act(() => root.unmount()) };
  roots.push(entry);
  return entry;
}

afterEach(() => { for (const r of roots) { try { r.unmount(); } catch (_) {} } roots = []; document.body.innerHTML = ''; });

beforeEach(() => {
  roots = [];
  mockNavigate.mockReset();
  mockExt = {
    status: { installed: true, connected: true },
    openTool: jest.fn(async () => ({ success: true })),
    reconnect: jest.fn(async () => ({ success: true })),
  };
  ctx = null;
});

test('retry with NO registered action never launches directly — it hands back to the owning page', async () => {
  mount();
  await act(async () => { ctx.startIssueByCode('TOOL_LAUNCH_FAILED', { toolId: 'tool-abc', toolName: 'Write Human' }); });
  await act(async () => { await ctx.performAction('retry', { toolId: 'tool-abc' }); });

  expect(mockExt.openTool).not.toHaveBeenCalled();
  expect(mockNavigate).toHaveBeenCalledWith('/client/tools');
});

test('retry USES the action the raiser registered, so the original card owns the result', async () => {
  const registered = jest.fn(async () => ({ success: true }));
  mount();
  await act(async () => { ctx.startIssueByCode('TOOL_LAUNCH_FAILED', { toolId: 'tool-abc', retry: registered }); });
  await act(async () => { await ctx.performAction('retry', {}); });

  expect(registered).toHaveBeenCalledTimes(1);
  expect(mockExt.openTool).not.toHaveBeenCalled();
});

test('opening and closing Zee causes no extension activity at all', async () => {
  mount();
  await act(async () => { ctx.openAssistant(); });
  await act(async () => { ctx.closeAssistant(); });
  await act(async () => { ctx.openAssistant(); });

  expect(mockExt.openTool).not.toHaveBeenCalled();
  expect(mockExt.reconnect).not.toHaveBeenCalled();
});

test('the draft survives close/reopen, and only Start over clears it', async () => {
  mount();
  await act(async () => { ctx.openAssistant(); ctx.setDraft('tool nahi khul raha'); });
  await act(async () => { ctx.closeAssistant(); });
  await act(async () => { ctx.openAssistant(); });
  expect(ctx.draft).toBe('tool nahi khul raha');

  await act(async () => { ctx.resetConversation(); });
  expect(ctx.draft).toBe('');
});

test('the transcript is bounded, so a long session cannot grow without limit', async () => {
  mount();
  await act(async () => {
    for (let i = 0; i < 60; i++) ctx.handleFreeText('tool not opening ' + i);
  });
  expect(ctx.history.length).toBeLessThanOrEqual(40);
  // and it keeps the MOST RECENT exchange, not the oldest
  expect(JSON.stringify(ctx.history)).toContain('59');
});

test('completion is the client\'s own answer and asserts nothing about the tool', async () => {
  mount();
  await act(async () => { ctx.startIssueByCode('TOOL_LAUNCH_FAILED', { toolId: 'tool-abc' }); });
  expect(ctx.outcome).toBe(null);

  await act(async () => { ctx.resolveOutcome('worked'); });
  expect(ctx.outcome).toBe('worked');
  expect(mockExt.openTool).not.toHaveBeenCalled();
  // it reports the client's verdict, never "logged in" / "fixed" / tool state
  expect(JSON.stringify(ctx.history)).not.toMatch(/logged in|all good|fixed/i);
});

test('a new flow clears a previous verdict, and an account change clears everything', async () => {
  mount();
  await act(async () => { ctx.startIssueByCode('TOOL_LAUNCH_FAILED', {}); ctx.resolveOutcome('worked'); });
  expect(ctx.outcome).toBe('worked');

  await act(async () => { ctx.startIssueByCode('EXTENSION_MISSING', {}); });
  expect(ctx.outcome).toBe(null);
});

test('render does not mount a second extension owner', () => {
  // useExtension is a shared owner; the provider must consume it, never instantiate another.
  const first = mount();
  expect(first.container.querySelector('[data-testid="probe"]')).toBeTruthy();
  first.unmount();
  expect(mockExt.openTool).not.toHaveBeenCalled();
  expect(mockExt.reconnect).not.toHaveBeenCalled();
});
