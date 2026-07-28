// One-time POST launch bootstrap — the browser side.
//
// WHAT CHANGED AND WHY
// Launching a tool used to be `window.open(res.data.url)`, where `url` was
// `https://<gateway>/gateway?lease=<JWT>`. That put a bearer credential — one that also
// carries the client id, tool and account id as readable claims — into the address bar, the
// browser history, the Referer of the first upstream request, and every access log along the
// way. Anyone who later read that URL off a shared machine could resume the session.
//
// Now the backend returns a single-use `launch` descriptor instead, and we submit it as a
// hidden cross-origin FORM POST. The code travels in the request BODY, so it never reaches a
// URL; the gateway redeems it once, sets an opaque HttpOnly cookie, and answers 303 — so the
// new tab lands on the clean tool URL with nothing sensitive anywhere in it.
//
// The code is held in a local variable for the few milliseconds between the fetch and the
// submit. It is never written to localStorage or sessionStorage, never logged, and it is dead
// after one redemption or ~45 seconds, whichever comes first.
import api from './api';

// ── CSRF token (see backend/middleware/csrf.js) ─────────────────────────────
// Kept in a module variable, deliberately NOT in storage: it must not survive a tab close and
// must not be readable by anything that can read storage.
let csrfToken = null;
let csrfInflight = null;

async function fetchCsrfToken() {
  const res = await api.get('/launch-token');
  csrfToken = (res && res.data && res.data.csrfToken) || null;
  return csrfToken;
}

/**
 * Get the CSRF token, fetching once and sharing a single in-flight request between
 * simultaneous launches (two tool cards clicked together must not race two fetches).
 * A failure resolves to null rather than throwing: an older backend has no such endpoint and
 * simply does not require the header, and blocking the launch on that would be a regression.
 */
export async function getCsrfToken(force = false) {
  if (csrfToken && !force) return csrfToken;
  if (!csrfInflight) {
    csrfInflight = fetchCsrfToken()
      .catch(() => null)
      .finally(() => { csrfInflight = null; });
  }
  return csrfInflight;
}

/** Headers for a launch POST. Omits the header entirely when no token could be obtained. */
export async function launchHeaders(force = false) {
  const t = await getCsrfToken(force);
  return t ? { 'X-CSRF-Token': t } : {};
}

/**
 * Run an authenticated launch request, transparently retrying ONCE on a CSRF rejection with a
 * freshly minted token. A token that merely aged out should be invisible to the user, not a
 * failed launch.
 *
 * @param {(headers:object) => Promise<any>} request receives the headers to attach
 */
export async function withCsrfRetry(request) {
  try {
    return await request(await launchHeaders());
  } catch (e) {
    if (e && e.response && e.response.status === 403 && e.response.data && e.response.data.code === 'csrf_invalid') {
      csrfToken = null;
      return request(await launchHeaders(true));
    }
    throw e;
  }
}

// ── The popup-blocker problem, and why the tab is opened BEFORE the request ──
// Browsers only allow a new tab to be opened while a user gesture is still "active". Fetching the
// launch code is an async round-trip, so by the time the response arrives the gesture is spent and
// `form.submit()` with target="_blank" — or `window.open` — is silently blocked. The click appears
// to do nothing, which is exactly what a client experiences as a dead Access button.
//
// So the tab is opened SYNCHRONOUSLY inside the click handler, before any await, and the launch is
// then delivered into that already-open tab. A form whose target names an EXISTING window navigates
// that window instead of trying to pop a new one, so no popup blocker is involved.
const LAUNCH_WINDOW_NAME = 'genzToolLaunch';

/**
 * Reserve the tool tab. MUST be called synchronously from the click handler, before any `await`.
 * Returns the window handle, or null when the browser blocked it outright (in which case the
 * caller should tell the user to allow popups rather than fail silently).
 */
export function openLaunchWindow() {
  let win = null;
  try {
    win = window.open('', LAUNCH_WINDOW_NAME);
  } catch (_) { win = null; }
  if (!win) return null;
  try {
    // Sever the opener link while the tab is still same-origin (about:blank). The tool tab must
    // never hold a handle on the dashboard — that is what `noopener` bought us before, and it must
    // survive the switch to a pre-opened window.
    win.opener = null;
    // A blank tab looks broken. One line of placeholder, replaced the moment the launch lands.
    win.document.write(
      '<!doctype html><meta charset="utf-8"><title>Opening…</title>' +
      '<body style="margin:0;display:flex;align-items:center;justify-content:center;' +
      'height:100vh;font:15px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
      'color:#64748b;background:#f8fafc">Opening your tool…</body>'
    );
    win.document.close();
  } catch (_) { /* cosmetic only — never fail a launch over the placeholder */ }
  return win;
}

/** Close a reserved tab when the launch never happened, so no stray blank tab is left behind. */
export function closeLaunchWindow(win) {
  try { if (win && !win.closed) win.close(); } catch (_) {}
}

/**
 * Open a tool from a backend open/capture response.
 *
 * Accepts BOTH shapes so a frontend build is never coupled to a particular backend rollout
 * state (and so the `LAUNCH_FLOW=url` rollback needs no frontend redeploy):
 *   • { launch: { url, code, field, method } } → hidden form POST  (current)
 *   • { url }                                  → navigation        (legacy / rollback)
 *
 * @param {object} data     the backend response body
 * @param {Window} [win]    a tab reserved by openLaunchWindow() during the click. Optional: when
 *                          omitted the previous behaviour is used unchanged, so existing callers
 *                          keep working exactly as before.
 * @returns {boolean} whether a launch was actually started
 */
export function openFromLaunchResponse(data, win) {
  if (!data) { closeLaunchWindow(win); return false; }

  const launch = data.launch;
  if (launch && launch.url && launch.code) {
    submitLaunchForm(launch, win);
    return true;
  }

  // Legacy URL flow.
  if (data.url) {
    if (win && !win.closed) {
      // `replace` so the placeholder does not become a history entry the user can go "back" to.
      try { win.location.replace(data.url); return true; } catch (_) { /* fall through */ }
    }
    window.open(data.url, '_blank', 'noopener');
    return true;
  }
  closeLaunchWindow(win);
  return false;
}

/**
 * Submit the one-time code as a cross-origin form POST into a new tab.
 *
 * Notes on the specifics, all of which matter:
 *  • `target="_blank"` + `rel="noopener"` — the tool tab must not get a handle on the
 *    dashboard window (`window.opener`), which would otherwise let proxied page script
 *    navigate the dashboard.
 *  • The form is created detached-then-attached, submitted, and removed immediately, so the
 *    code never lingers in the DOM for an extension or a later script to read.
 *  • No `action` query string, ever: that is the whole point of this module.
 */
function submitLaunchForm(launch, win) {
  const form = document.createElement('form');
  form.method = (launch.method || 'POST').toUpperCase() === 'GET' ? 'POST' : 'POST'; // never GET
  form.action = launch.url;
  // Target the tab reserved during the click when we have one. Naming an EXISTING window makes
  // this a navigation of that window rather than a popup, so the blocker is never involved. Only
  // when no tab was reserved do we fall back to '_blank', which is the path that can be blocked.
  form.target = (win && !win.closed) ? LAUNCH_WINDOW_NAME : '_blank';
  form.rel = 'noopener';
  form.style.display = 'none';
  // Default encoding (application/x-www-form-urlencoded) keeps this a simple request, so the
  // gateway needs no CORS preflight for what is a plain top-level navigation.

  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = launch.field || 'code';
  input.value = launch.code;
  form.appendChild(input);

  document.body.appendChild(form);
  try {
    form.submit();
  } finally {
    // Clear the value before detaching so the code is not left sitting in a detached node.
    input.value = '';
    if (form.parentNode) form.parentNode.removeChild(form);
  }
}

export default {
  getCsrfToken, launchHeaders, withCsrfRetry,
  openLaunchWindow, closeLaunchWindow, openFromLaunchResponse,
};
