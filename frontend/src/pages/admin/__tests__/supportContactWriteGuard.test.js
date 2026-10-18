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

  test('only an explicit true permits; an explicit false blocks', () => {
    expect(isStoredKnown({ loadFailed: false, view: ok({ storedAvailable: true }) })).toBe(true);
    expect(isStoredKnown({ loadFailed: false, view: ok({ storedAvailable: false }) })).toBe(false);
  });

  test('a MALFORMED availability flag fails safe', () => {
    // A broken contract is not permission to write. Anything present that is not exactly true or
    // false means the response cannot be trusted about what is stored.
    for (const v of [null, 0, 1, '', 'false', 'true', 'yes', {}, []]) {
      expect(isStoredKnown({ loadFailed: false, view: ok({ storedAvailable: v }) }))
        .toBe(false);
    }
  });

  test('a MALFORMED stored block fails safe', () => {
    for (const stored of [null, undefined, 'nope', 42, []]) {
      expect(isStoredKnown({ loadFailed: false, view: { storedAvailable: true, stored } })).toBe(false);
    }
    // Right shape, wrong field types.
    expect(isStoredKnown({ loadFailed: false, view: { storedAvailable: true, stored: { whatsappNumber: 923001234567, supportEmail: '' } } })).toBe(false);
    expect(isStoredKnown({ loadFailed: false, view: { storedAvailable: true, stored: { whatsappNumber: '', supportEmail: { a: 1 } } } })).toBe(false);
  });
});

describe('MIXED VERSIONS: the backend half of this fix is not deployed yet', () => {
  // Production today runs a backend that does NOT send storedAvailable, so the flag check alone
  // would be inert and the page would still offer to clear real values. The fallback uses a
  // consistency check between two fields the CURRENT response already carries: contact.source is
  // 'admin' only when the row was read and held a valid value, so 'admin' plus blank stored values
  // is a contradiction and means the admin-view read failed.
  const legacy = (over = {}) => ({
    contact: { whatsappNumber: '923355500134', email: 'a@b.c', source: 'admin' },
    stored: { whatsappNumber: '', supportEmail: '', updatedAt: null },
    fallback: { whatsappNumber: '923355500134', email: 'a@b.c', source: 'default' },
    ...over,   // deliberately NO storedAvailable
  });

  test('legacy backend + blank stored + source "admin" = read failed -> BLOCKED', () => {
    expect(isStoredKnown({ loadFailed: false, view: legacy() })).toBe(false);
  });

  test('legacy backend + blank stored + source "env" = genuinely empty -> editable', () => {
    // An admin configuring the contact for the first time must still be able to save.
    const v = legacy({ contact: { whatsappNumber: '923355500134', email: 'a@b.c', source: 'env' } });
    expect(isStoredKnown({ loadFailed: false, view: v })).toBe(true);
  });

  test('legacy backend + blank stored + source "default" = genuinely empty -> editable', () => {
    const v = legacy({ contact: { whatsappNumber: '923355500134', email: 'a@b.c', source: 'default' } });
    expect(isStoredKnown({ loadFailed: false, view: v })).toBe(true);
  });

  test('legacy backend + stored values present -> editable whatever the source', () => {
    for (const source of ['admin', 'env', 'default']) {
      const v = legacy({
        contact: { whatsappNumber: '923355500134', email: 'a@b.c', source },
        stored: { whatsappNumber: '923001234567', supportEmail: 'help@x.com', updatedAt: null },
      });
      expect(isStoredKnown({ loadFailed: false, view: v })).toBe(true);
    }
  });

  test('legacy backend with ONE stored field set is still editable', () => {
    // Only a fully blank stored block is contradictory; a partially configured record is not.
    const v = legacy({ stored: { whatsappNumber: '923001234567', supportEmail: '', updatedAt: null } });
    expect(isStoredKnown({ loadFailed: false, view: v })).toBe(true);
  });

  test('legacy backend with no contact block at all -> treated as empty, editable', () => {
    // Without a source there is nothing to contradict; do not lock the editor on missing data.
    const v = legacy({ contact: undefined });
    expect(isStoredKnown({ loadFailed: false, view: v })).toBe(true);
  });

  test('the NEW backend contract still wins over the fallback', () => {
    // Once the backend sends the flag, it is authoritative in both directions.
    expect(isStoredKnown({ loadFailed: false, view: { ...legacy(), storedAvailable: true } })).toBe(true);
    const withValues = legacy({ stored: { whatsappNumber: '923001234567', supportEmail: 'h@x.c' } });
    expect(isStoredKnown({ loadFailed: false, view: { ...withValues, storedAvailable: false } })).toBe(false);
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
