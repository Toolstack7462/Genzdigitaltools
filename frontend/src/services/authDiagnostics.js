import api from './api';

/**
 * The ONLY string a production member is ever shown for an API / auth / timeout /
 * DNS / CORS / network failure. It intentionally carries NO API URL or host, NO
 * internal [CODE], NO stack trace, NO server response body, NO configuration, and NO
 * technical troubleshooting steps. All of that lives in the dev console + server logs.
 */
export const SAFE_GENERIC_MESSAGE =
  "We're unable to complete your request right now. Please try again shortly.";

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
 * Probes, in order, {apiOrigin}/api/crm/health (the canonical route that has always
 * existed), then /api/health and /health (aliases kept for older cached bundles) —
 * via fetch, NOT the axios instance, so the 401 auto-refresh interceptor never touches
 * it and no credentials/cookies are sent. Returns on the FIRST path that answers:
 *   true  → the server ANSWERED (any HTTP status, even 404/503) ⇒ API is reachable.
 *   false → no response on ANY path ⇒ genuinely unreachable (offline / DNS / firewall /
 *           VPN / ad-blocker / TLS-cert-or-clock / CORS-level block).
 * Treating a non-2xx as "reachable" is deliberate: a 404 (old path) or 503 (DB blip)
 * means the SERVER replied, so it must never be reported as a device connection failure.
 */
export async function pingHealth(timeoutMs = 6000) {
  const { origin } = apiContext();
  if (!origin) return false;
  for (const path of ['/api/crm/health', '/api/health', '/health']) {
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

/**
 * Whether detailed diagnostics may be rendered ON SCREEN to THIS viewer. True ONLY in a
 * development build. CRA inlines process.env.NODE_ENV at build time, so the deployed
 * production bundle evaluates this to `false` unconditionally — production members ALWAYS
 * see SAFE_GENERIC_MESSAGE / the safe branch messages on screen, never internals, even
 * with ?debug=1 set. Rich diagnostics in production stay in the console (gated separately
 * by loginDebugEnabled(), an opt-in support tool) and the correlated server-side logs.
 */
export function diagnosticsVisible() {
  try {
    return typeof process !== 'undefined' && !!process.env && process.env.NODE_ENV === 'development';
  } catch (_) { return false; }
}

/**
 * THE single, centralized sanitizer for EVERY API / auth / timeout / DNS / CORS /
 * network failure surfaced to a member (login, signup, admin login, and any future
 * caller). It GUARANTEES the user-facing string never contains an API URL or host, an
 * internal [CODE], a stack trace, a raw server response body, configuration, or
 * technical troubleshooting steps. The rich (still secret-free) detail is returned
 * separately for the dev console + server-correlated logs only.
 *
 * @param {*} error  an axios error (or any thrown value)
 * @param {object} ctx  extra secret-free context to attach to the diagnostic (e.g. { rid })
 * @returns {{ userMessage: string, devMessage: string, code: string, connection: boolean, detail: object }}
 *   userMessage — ALWAYS safe; show this to production members.
 *   devMessage  — userMessage in production; userMessage + internal detail when diagnosticsVisible().
 *   code        — internal machine code for logs ONLY; never render it in the UI.
 *   connection  — true when the request got no usable HTTP response (offline/timeout/unreachable).
 *   detail      — secret-free client facts for the dev console / correlation with server logs.
 */
export function sanitizeError(error, ctx = {}) {
  const transport = classifyTransport(error);          // offline / timeout / unreachable-or-blocked
  const status = error?.response?.status || null;
  const serverCode = error?.response?.data?.code || null;

  let code;            // INTERNAL only — never shown to a production user
  let connection = false;
  let userMessage;

  if (transport) {
    // No usable HTTP response: offline / timeout / DNS / CORS / TLS-or-clock / host blocked.
    // This is the device-specific class behind [API_CONNECTION_FAILED] in the screenshot.
    code = transport.code;               // API_CONNECTION_FAILED | TIMEOUT
    connection = true;
    userMessage = SAFE_GENERIC_MESSAGE;
  } else if (serverCode === 'DEVICE_PENDING') {
    // Safe, user-ACTIONABLE outcomes keep a human message (no host, no body, no [CODE]).
    code = 'NEW_DEVICE_PENDING';
    userMessage = 'New device detected. Your account is locked to one device — please ask the admin to approve this device, then sign in again.';
  } else if (serverCode === 'DEVICE_BLOCKED' || serverCode === 'DEVICE_MISMATCH') {
    code = 'DEVICE_BLOCKED';
    userMessage = 'This device is not approved for your account. Please ask the admin to approve or reset your device.';
  } else if (serverCode === 'RESEND_COOLDOWN' || serverCode === 'RESEND_LIMIT') {
    // Safe + actionable: tell them exactly how long to wait. No host, no internals.
    const wait = Number(error?.response?.data?.retryAfterSeconds) || 0;
    code = serverCode;
    userMessage = wait
      ? `Please wait ${wait} seconds before requesting another code.`
      : 'You have requested too many codes. Please wait a moment and try again.';
  } else if (typeof serverCode === 'string' && /^(EMAIL_|SMTP_|TEMPLATE_ERROR)/.test(serverCode)) {
    // The server reached us fine; sending the message failed. Naming the email step
    // is safe (it exposes nothing about our infrastructure) and far more useful than
    // the generic fallback, because retrying is the correct user action.
    code = serverCode;
    userMessage = 'We could not send your verification email just now. Please check the address and try again in a moment.';
  } else if (status === 401) {
    code = 'WRONG_CREDENTIALS';
    userMessage = 'Incorrect email or password. Please check them and try again.';
  } else if (status === 409) {
    code = 'ACCOUNT_EXISTS';
    userMessage = 'An account with this email already exists. Please log in instead.';
  } else if (status === 429) {
    code = 'TOO_MANY_ATTEMPTS';
    userMessage = 'Too many attempts. Please wait a few minutes, then try again.';
  } else {
    // 400 / 403 / 404 / 5xx / anything else → one safe, generic message. We deliberately
    // do NOT echo the server's response body, its status, or a bracketed code to the user.
    code = status ? ('HTTP_' + status) : 'UNKNOWN';
    userMessage = SAFE_GENERIC_MESSAGE;
  }

  const detail = collectClientDiag(error, { ...ctx, code, connection });

  // Developer-only string (dev build, or explicit ?debug=1 opt-in). Appends the internal
  // code + precise transport reason so engineers keep full visibility. NEVER shown to a
  // production member — pages must gate on diagnosticsVisible() before using it.
  const devTail = transport ? ` · ${transport.message}` : (status ? ` · HTTP ${status}` : '');
  const devMessage = diagnosticsVisible() ? `${userMessage} [dev:${code}${devTail}]` : userMessage;

  return { userMessage, devMessage, code, connection, detail };
}

// Short, URL-safe correlation id for ONE login/signup attempt. The same id is sent to
// the backend (X-Request-Id header) and shown to the user as "Error ID", so a reported
// failure is searchable in the server's [login-diag]/[auth:*]/[signup] logs.
export function newRequestId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().slice(0, 8);
  } catch (_) { /* fall through */ }
  return Math.random().toString(36).slice(2, 10);
}

// Mask an email for any client-side log: user@gmail.com -> u***@gmail.com.
export function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return s ? '***' : '';
  return s[0] + '***' + s.slice(at);
}

// Verbose client logging is OFF by default. Turn it on per-device WITHOUT a redeploy via
// ?debug=1 in the URL or localStorage.genz_login_debug='1'. The basic one-line authDiag()
// stays always-on; this only gates the richer console dump.
export function loginDebugEnabled() {
  try {
    const p = new URLSearchParams(window.location.search);
    if (p.get('debug') === '1' || p.get('debug') === 'true') return true;
    return window.localStorage.getItem('genz_login_debug') === '1';
  } catch (_) { return false; }
}

// Best-effort, non-throwing service-worker / cache-storage status (for diagnosing stale
// bundles). This app registers no SW, so "controlled" would flag a legacy one.
function swCacheStatus() {
  try {
    if ('serviceWorker' in navigator) {
      return navigator.serviceWorker.controller ? 'controlled-by-sw' : 'none';
    }
  } catch (_) { /* ignore */ }
  return 'unsupported';
}

// A SAFE, non-secret bundle of client-side facts for diagnosing a login/signup failure.
// NEVER includes passwords/tokens/cookies/emails (email is masked if passed in extra).
export function collectClientDiag(error, extra = {}) {
  const { host, origin, crossOrigin } = apiContext();
  const transport = classifyTransport(error);
  const status = error?.response?.status;
  let errorType;
  if (transport?.code === 'TIMEOUT') errorType = 'timeout';
  else if (transport) errorType = 'network';            // unreachable / CORS / DNS / SSL
  else if (status === 404) errorType = '404';
  else if (status === 401) errorType = 'invalid_credentials';
  else if (status === 403) errorType = 'forbidden';
  else if (status === 429) errorType = 'rate_limited';
  else if (status >= 500) errorType = 'server';
  else if (status) errorType = 'http_' + status;
  else errorType = 'unknown';

  let bundle = 'unknown';
  try {
    const s = document.querySelector('script[src*="/static/js/main."]');
    if (s) bundle = s.src.split('/').pop();
  } catch (_) { /* ignore */ }

  const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '';
  let browser = 'Browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua) || /Opera/.test(ua)) browser = 'Opera';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';

  return {
    ...extra,                               // rid, healthEndpoint, reachable, email(masked)
    errorType,
    status: status || null,
    axiosCode: error?.code || null,
    timeout: error?.code === 'ECONNABORTED',
    online: typeof navigator !== 'undefined' ? navigator.onLine : null,
    apiHost: host,
    apiOrigin: origin,
    crossOrigin,
    appOrigin: (typeof window !== 'undefined' && window.location) ? window.location.origin : '',
    bundle,
    browser,
    serviceWorker: swCacheStatus(),
    ua: ua.slice(0, 160),
  };
}
