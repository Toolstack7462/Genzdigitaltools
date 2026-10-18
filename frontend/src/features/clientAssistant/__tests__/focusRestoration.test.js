// Gen Z Guide — FOCUS RESTORATION (WCAG 2.4.3 Focus Order).
//
// WHY THIS TEST EXISTS. ClientGuideLauncher returns null while the panel is open, so the launcher
// button is removed from the accessibility tree for as long as the assistant is showing. The panel
// moves focus to its own close button on open (ClientGuidePanel), but nothing ever gave focus back
// on close — so dismissing the assistant with Escape or the X left document.activeElement on
// <body>. A keyboard or screen-reader client was dropped at the very start of the document and had
// to tab through the whole sidebar and page to get back to where they were.
//
// The panel is deliberately NON-modal (aria-modal="false"), so it needs no focus trap — but a
// dialog that takes focus must still return it to the control that opened it.
//
// RTL is not installed in this project (see renderScope.test.js), so this drives React directly
// with createRoot + act, which is real behaviour rather than a source-text match.
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

// The launcher reads its state from the provider's context hook; mock just that so this test is
// about focus and nothing else (the real provider pulls in react-router, the extension bridge and
// authService).
let mockGuide;
jest.mock('../ClientGuideProvider', () => ({
  __esModule: true,
  useClientGuide: () => mockGuide,
}));
// The avatar engine is irrelevant here and renders SVG/animation internals.
jest.mock('../AvatarRenderer', () => ({
  __esModule: true,
  default: () => null,
}));

// eslint-disable-next-line import/first
import ClientGuideLauncher from '../ClientGuideLauncher';

const baseGuide = (over = {}) => ({
  open: false,
  openAssistant: () => {},
  prompt: null,
  dismissPrompt: () => {},
  startIssueByCode: () => {},
  avatarState: 'idle',
  returnFocusToken: 0,
  ...over,
});

describe('Gen Z Guide — focus returns to the launcher when the assistant closes', () => {
  let container;
  let root;

  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    global.IS_REACT_ACT_ENVIRONMENT = false;
  });

  const render = () => act(() => { root.render(<ClientGuideLauncher />); });
  const launcherBtn = () => container.querySelector('button.cga-launcher');

  test('does NOT steal focus on first paint', () => {
    mockGuide = baseGuide();
    render();
    expect(launcherBtn()).toBeTruthy();
    // Landing on a client page must not yank focus into the assistant.
    expect(document.activeElement).toBe(document.body);
  });

  test('is hidden while the panel is open', () => {
    mockGuide = baseGuide({ open: true });
    render();
    expect(launcherBtn()).toBeNull();
  });

  test('takes focus back after the panel closes', () => {
    // 1. closed → launcher visible, focus untouched
    mockGuide = baseGuide();
    render();

    // 2. opened → launcher unmounts; the panel owns focus (simulated: focus leaves the launcher)
    mockGuide = baseGuide({ open: true });
    render();
    expect(launcherBtn()).toBeNull();
    expect(document.activeElement).toBe(document.body);

    // 3. closed again. closeAssistant() bumps returnFocusToken, which is the launcher's cue that
    //    this is a RETURN from the dialog rather than a first paint.
    mockGuide = baseGuide({ open: false, returnFocusToken: 1 });
    render();

    const btn = launcherBtn();
    expect(btn).toBeTruthy();
    expect(document.activeElement).toBe(btn);
  });

  test('does not re-steal focus on later re-renders with an unchanged token', () => {
    mockGuide = baseGuide({ open: false, returnFocusToken: 1 });
    render();
    expect(document.activeElement).toBe(launcherBtn());

    // Something else on the page takes focus; a re-render must not snatch it back.
    const other = document.createElement('button');
    document.body.appendChild(other);
    other.focus();
    expect(document.activeElement).toBe(other);

    mockGuide = baseGuide({ open: false, returnFocusToken: 1, avatarState: 'thinking' });
    render();
    expect(document.activeElement).toBe(other);
    other.remove();
  });
});
