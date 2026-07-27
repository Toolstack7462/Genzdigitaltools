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

/**
 * Open a tool from a backend open/capture response.
 *
 * Accepts BOTH shapes so a frontend build is never coupled to a particular backend rollout
 * state (and so the `LAUNCH_FLOW=url` rollback needs no frontend redeploy):
 *   • { launch: { url, code, field, method } } → hidden form POST  (current)
 *   • { url }                                  → window.open       (legacy / rollback)
 *
 * @returns {boolean} whether a launch was actually started
 */
export function openFromLaunchResponse(data) {
  if (!data) return false;

  const launch = data.launch;
  if (launch && launch.url && launch.code) {
    submitLaunchForm(launch);
    return true;
  }

  // Legacy URL flow — unchanged behaviour, including the noopener hardening.
  if (data.url) {
    window.open(data.url, '_blank', 'noopener');
    return true;
  }
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
function submitLaunchForm(launch) {
  const form = document.createElement('form');
  form.method = (launch.method || 'POST').toUpperCase() === 'GET' ? 'POST' : 'POST'; // never GET
  form.action = launch.url;
  form.target = '_blank';
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

export default { getCsrfToken, launchHeaders, withCsrfRetry, openFromLaunchResponse };
