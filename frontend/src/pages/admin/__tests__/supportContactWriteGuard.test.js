// ADMIN → SUPPORT CONTACT: a failed settings read must never become an accidental reset.
//
// THE FAILURE THIS PREVENTS. The form fills its fields from `stored`. getAdminView() used to seed
// `stored` with empty strings and swallow a failed or timed-out row read, so a transient DB problem
// returned EXACTLY what "nothing has ever been saved" returns. The screen then showed BLANK but
// EDITABLE fields — and an empty string on PUT means "clear to the fallback". One Save on that
// screen destroyed the live support WhatsApp number and email, with no error shown anywhere,
// because the request had succeeded.
//
// SCOPE. These are logic-and-contract tests, not a full browser render: `isStoredKnown` is the
// exported predicate every write control is gated on, and the source assertions below prove the
// controls are actually gated on it. The behavioural guarantee on the server side — that a failed
// read reports `storedAvailable: false` rather than blank values — is covered in
// backend/tests/supportContact.test.js against the real module. Live admin verification after
// deployment is listed separately and is NOT claimed here.
import fs from 'fs';
import path from 'path';

// The page imports the admin layout, which pulls in react-router-dom. Under jest that package's
// `react-router/dom` subpath does not resolve in this checkout, so the layout is stubbed — this
// test is about the write guard, not the admin chrome.
jest.mock('../../../components/AdminLayoutEnhanced', () => ({
  __esModule: true,
  default: ({ children }) => children,
  ADMIN_CARD_VARIANTS: { default: '' },
}));

// eslint-disable-next-line import/first
import { isStoredKnown } from '../AdminSupportContact';

const ok = (over = {}) => ({ storedAvailable: true, stored: { whatsappNumber: '', supportEmail: '' }, ...over });

describe('isStoredKnown: the write guard', () => {
  test('a successful read with stored values permits writing', () => {
    expect(isStoredKnown({ loadFailed: false, view: ok({ stored: { whatsappNumber: '923001234567', supportEmail: 'a@b.c' } }) })).toBe(true);
  });

  test('a successful read of a GENUINELY empty record still permits writing', () => {
    // This is the case that must keep working: the admin may legitimately see blanks and save.
    expect(isStoredKnown({ loadFailed: false, view: ok() })).toBe(true);
  });

  test('storedAvailable:false BLOCKS writing — blank means unknown, not empty', () => {
    expect(isStoredKnown({ loadFailed: false, view: ok({ storedAvailable: false }) })).toBe(false);
  });

  test('a failed GET blocks writing', () => {
    expect(isStoredKnown({ loadFailed: true, view: null })).toBe(false);
    // Even if a stale view is still in state, an explicit load failure wins.
    expect(isStoredKnown({ loadFailed: true, view: ok() })).toBe(false);
  });

  test('no view at all blocks writing', () => {
    expect(isStoredKnown({ loadFailed: false, view: null })).toBe(false);
    expect(isStoredKnown({ loadFailed: false, view: undefined })).toBe(false);
  });

  test('an older server that omits storedAvailable is treated as available', () => {
    // Forward compatibility: a deployed API predating the flag must not lock the editor.
    expect(isStoredKnown({ loadFailed: false, view: { stored: { whatsappNumber: '', supportEmail: '' } } })).toBe(true);
  });

  test('only an explicit false blocks — truthy or absent values do not', () => {
    for (const v of [true, undefined, 1, 'yes']) {
      expect(isStoredKnown({ loadFailed: false, view: { storedAvailable: v } })).toBe(true);
    }
    expect(isStoredKnown({ loadFailed: false, view: { storedAvailable: false } })).toBe(false);
  });
});

describe('the page actually gates every write control on that guard', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'AdminSupportContact.js'), 'utf8');

  test('the submit button and the reset-to-fallback button are both disabled when unknown', () => {
    const disables = src.match(/disabled=\{saving \|\| !storedKnown\}/g) || [];
    expect(disables.length).toBeGreaterThanOrEqual(2);
  });

  test('the submit handler refuses as well, for the Enter-key path', () => {
    // A form can be submitted by pressing Enter in a field even with the button disabled, so the
    // guard cannot live on the button alone.
    expect(src).toMatch(/onSubmit=\{\(e\) => \{[\s\S]*?if \(!storedKnown\) return;/);
  });

  test('the reset-to-fallback click handler refuses as well', () => {
    expect(src).toMatch(/onClick=\{\(\) => \{ if \(!storedKnown\) return;/);
  });

  test('both inputs are disabled when the stored values are unknown', () => {
    const inputs = src.match(/data-testid="support-(whatsapp|email)-input"/g) || [];
    expect(inputs.length).toBe(2);
    expect((src.match(/disabled=\{!storedKnown\}/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  test('the operator is told the values are unknown rather than empty', () => {
    expect(src).toMatch(/support-stored-unavailable/);
    expect(src).toMatch(/could not be read/i);
    expect(src).toMatch(/unknown/i);
    expect(src).toMatch(/Saving is disabled/i);
    // And that visitors are unaffected, so nobody panics about the public site.
    expect(src).toMatch(/Visitors are unaffected/i);
  });

  test('a failed load clears any stale form values instead of offering them for save', () => {
    expect(src).toMatch(/setLoadFailed\(true\)/);
    expect(src).toMatch(/setView\(null\)/);
  });
});
