/**
 * Client-facing credential safety (single chokepoint).
 *
 * THE RULE: a reusable PROVIDER ACCOUNT PASSWORD must never leave the trusted
 * admin/source environment. Session material (cookies, tokens, localStorage,
 * sessionStorage) is a different class and still flows to clients — that is the
 * product. A master email+password is categorically worse than a session: it
 * grants full account control (change password, change email, billing, and
 * logging every other client out), it does not expire with the lease, and it
 * cannot be revoked by rotating a session.
 *
 * Client-side form fill therefore cannot be made safe for a SHARED master
 * account: anything the client's browser must type, the client can read. The
 * supported way to use a shared account is the source-side pipeline that
 * WriteHuman already uses — the admin/source environment logs in, and only the
 * resulting SESSION is distributed.
 *
 * These helpers are deliberately PATH-TARGETED rather than a recursive sweep:
 * a blind scrub over `credentials.payload` would corrupt cookie/token/storage
 * payloads (a cookie may legitimately be named "password"), which would break
 * session injection for every tool. Each function returns a COPY and never
 * mutates the caller's document, so server-side use of the real credentials
 * (admin verify, source-side login) is unaffected.
 */

// Reusable account password fields. `username` rides along because on its own it
// is the other half of the master credential pair and the client never needs it
// for session injection.
const MASTER_FIELDS = ['username', 'password'];

function plain(v) {
  if (!v || typeof v !== 'object') return {};
  return Object.assign({}, typeof v.toObject === 'function' ? v.toObject() : v);
}

/**
 * comboAuth for a CLIENT-facing response: every behavioural flag is preserved
 * exactly; only formConfig's master credential fields are dropped. The
 * credentials are dropped UNCONDITIONALLY — including when form/combo auth is
 * enabled — because no client-side caller is a trusted holder of them.
 */
function sanitizeComboAuthForClient(comboAuth) {
  if (!comboAuth) return comboAuth;
  const out = plain(comboAuth);
  if ('formConfig' in out) {
    const fc = plain(out.formConfig);
    for (const k of MASTER_FIELDS) delete fc[k];
    out.formConfig = fc;
  }
  return out;
}

/**
 * The unified `credentials` object for a CLIENT-facing response. For a 'form'
 * tool the decrypted payload IS {username, password}, so those fields are
 * removed. Every other type's payload (cookies array, token value, storage map)
 * is passed through byte-identical — it is the session the client must inject.
 */
function sanitizeCredentialsForClient(credentials) {
  if (!credentials || typeof credentials !== 'object') return credentials;
  if (credentials.type !== 'form') return credentials;
  const out = Object.assign({}, credentials);
  const payload = out.payload;
  // Only object payloads carry named credential fields; leave arrays/strings alone.
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const p = plain(payload);
    for (const k of MASTER_FIELDS) delete p[k];
    out.payload = p;
  }
  return out;
}

/**
 * Assertion helper used by tests and callable in diagnostics: true when a
 * response body contains no master-credential field at any depth. Checks field
 * NAMES under the two known credential-bearing containers only.
 */
function containsMasterCredential(body) {
  const hits = [];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return; // session payloads — not credential containers
    for (const [k, v] of Object.entries(node)) {
      const here = path ? path + '.' + k : k;
      const inFormConfig = /(^|\.)formConfig$/.test(path);
      const inFormPayload = /(^|\.)payload$/.test(path) && node !== body;
      if (MASTER_FIELDS.includes(k) && (inFormConfig || inFormPayload)) hits.push(here);
      walk(v, here);
    }
  };
  walk(body, '');
  return hits;
}

module.exports = {
  MASTER_FIELDS,
  sanitizeComboAuthForClient,
  sanitizeCredentialsForClient,
  containsMasterCredential,
};
