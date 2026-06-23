import api from './api';

/**
 * Shared, SECRET-FREE diagnostics for the login & signup flows.
 *
 * Why this exists: some clients see a generic "Login failed" on ONE device while the
 * SAME email/password works on another device, and signup ALSO fails on that device.
 * Signup sends no deviceId and touches no localStorage, so the common factor is the
 * HTTP request itself never completing to the API origin (api.genzdigitalstore.com).
 * Browsers expose every such transport failure as the same opaque "Network Error"
 * with no response, so the UI used to collapse them all into one vague message. This
 * helper turns an axios error into an EXACT, member-readable reason + a short [CODE].
 *
 * It NEVER inspects or logs passwords, cookies, tokens, sessions, or request/response
 * bodies — only status codes, the axios error code, online state, and the API host.
 */

// The API origin this build talks to, and whether auth calls are cross-origin.
// In production the app is served from app.genzdigitalstore.com and the API lives at
// api.genzdigitalstore.com, so every auth call is a cross-site request — which is what
// makes it sensitive to wrong device clocks (TLS cert), security suites / VPN / DNS
// filters / ad-blockers blocking the API host, or strict private-mode cross-site rules.
function apiContext() {
  try {
    const base = api?.defaults?.baseURL || '';
    const url = base ? new URL(base, window.location.origin) : new URL(window.location.origin);
    return { host: url.host, origin: url.origin, crossOrigin: !!base && url.origin !== window.location.origin };
  } catch {
    return { host: '', origin: '', crossOrigin: false };
  }
}

/**
 * Active reachability probe used by the login/signup screens to tell "the API is
 * unreachable from this device" apart from a transient blip, a 404, or bad creds.
 *
 * GETs {apiOrigin}/api/health (then /health) with a short timeout, via fetch — NOT
 * the axios instance — so the 401 auto-refresh interceptor never touches it, and
 * never sends credentials/cookies. Returns:
 *   true  → the server ANSWERED (any HTTP status, even 404) ⇒ API is reachable.
 *   false → no response on either path ⇒ genuinely unreachable (offline / DNS /
 *           firewall / VPN / ad-blocker / TLS-cert/clock / CORS-level block).
 * Treating a 404 as "reachable" is deliberate: an old build hitting a not-yet-
 * deployed health path must never be reported as a connection failure.
 */
export async function pingHealth(timeoutMs = 6000) {
  const { origin } = apiContext();
  if (!origin) return false;
  for (const path of ['/api/health', '/health']) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      // eslint-disable-next-line no-await-in-loop
      const r = await fetch(origin + path, { method: 'GET', cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      return !!r; // any response object = server reachable
    } catch (_) {
      // network/abort/CORS error → try the next path, else fall through to false
    }
  }
  return false;
}

// Secret-free object to console.error so a member reporting a failure can be told
// exactly which branch fired. `hadResponse:false` => the server never answered
// (network / CORS / cert / timeout); a present `status` => the server replied.
export function authDiag(error, extra = {}) {
  const { host, crossOrigin } = apiContext();
  return {
    status: error?.response?.status || null,
    serverCode: error?.response?.data?.code || null,
    axiosCode: error?.code || null, // ECONNABORTED = timeout, ERR_NETWORK = network/CORS/cert
    hadResponse: !!error?.response,
    hadRequest: !!error?.request,
    online: typeof navigator !== 'undefined' ? navigator.onLine : null,
    apiHost: host,
    crossOrigin,
    ...extra,
  };
}

/**
 * Classify a TRANSPORT failure (no usable HTTP response). Returns null when the server
 * actually answered — the caller maps that status / business code itself.
 *
 * Codes: API_CONNECTION_FAILED (offline or API unreachable/blocked from this device)
 * and TIMEOUT. A true CORS misconfiguration is intentionally NOT reported as a distinct
 * code: it is indistinguishable from a network/cert block in the browser AND a real
 * CORS fault would break EVERY client, not one device — so we name CORS only as one of
 * the possible causes in the message and keep the accurate headline code.
 */
export function classifyTransport(error) {
  if (error?.response) return null; // server replied → not a transport failure

  // 1) Device is offline (airplane mode / dropped Wi-Fi).
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return {
      code: 'API_CONNECTION_FAILED',
      message:
        'Your device appears to be offline. Please check your internet connection, then try again. [API_CONNECTION_FAILED]',
    };
  }

  // 2) Client-side timeout (server cold start / dropped mid-flight).
  if (error?.code === 'ECONNABORTED') {
    return {
      code: 'TIMEOUT',
      message: 'The server took too long to respond. Please wait a moment and try again. [TIMEOUT]',
    };
  }

  // 3) Request was sent but NO response came back — the device-specific case. Same
  // opaque error for: a blocked cross-site request (CORS / strict private mode), a
  // WRONG device date & time (which makes the HTTPS security certificate look invalid),
  // or the API host being blocked by a VPN / firewall / ad-blocker / antivirus / DNS
  // filter. We can't tell these apart from JavaScript, so we name the fixable causes.
  if (error?.request || error?.code === 'ERR_NETWORK') {
    const { host } = apiContext();
    const where = host || 'the secure server';
    return {
      code: 'API_CONNECTION_FAILED',
      message:
        `We couldn't reach ${where} from this device. Please check, on THIS device: ` +
        `(1) the date & time are correct, ` +
        `(2) no VPN, firewall, ad-blocker or antivirus/security software is blocking ${where}, and ` +
        `(3) you are not in a restricted private/incognito window. Then try again. [API_CONNECTION_FAILED]`,
    };
  }

  return null;
}
