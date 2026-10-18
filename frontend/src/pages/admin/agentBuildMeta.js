// What the dashboard may say about the Windows agent installer — and what it may not.
//
// THE BUG THIS REPLACES
// ---------------------
// The page fetched /downloads/writehuman-agent/windows/latest.json once on mount, kept whatever
// came back in a single `agentBuild` variable, and rendered:
//
//     <a href=".../windows/latest" download title={agentBuild ? `v${agentBuild.version} …` : …}>
//       Download Windows Agent{agentBuild ? ` v${agentBuild.version}` : ''}
//
// Three separate defects came out of that one line:
//
//   1. `agentBuild === null` has three different causes — the request is still in flight, the
//      server answered 404 "no build published", or the request failed — and all three rendered
//      the same thing: a live, enabled download button with no version on it. Clicking it when
//      nothing is published downloads a 404 body.
//   2. The metadata was never validated. A truncated or half-written latest.json with a `version`
//      and nothing else produced a confident "Download Windows Agent v3.5.15" whose bytes are
//      whatever happens to be on disk.
//   3. "update available → X" elsewhere on the page came from the backend's EXPECTED_AGENT_VERSION
//      constant, not from this metadata. The dashboard therefore advertised an update to a version
//      the public download does not serve. (Production publishes 3.5.3; the constant says 3.5.15.)
//
// So: the installed version, the PUBLISHED version and whether an update can actually be installed
// are three different facts, computed here from their own sources, and a claim is made only when
// the evidence for it exists.
//
// Pure: no network, no React, no clock. The page owns fetching; this module owns truth.

/** Status of the metadata request. The page may not collapse these into one falsy check. */
export const META = {
  LOADING: 'loading',       // in flight, nothing known yet
  READY: 'ready',           // valid metadata for a published installer
  UNPUBLISHED: 'unpublished', // the server says plainly that no build is published
  INVALID: 'invalid',       // answered, but the metadata does not describe a usable installer
  ERROR: 'error',           // the request failed
};

const HEX64 = /^[0-9a-f]{64}$/i;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Validate a /windows/latest.json body before anything is shown to an operator.
 *
 * A published installer needs all four facts: which version, how many bytes, the digest of those
 * bytes, and the route's own ok flag. Any one missing means the dashboard does not know what the
 * download would serve, and must not name a version.
 *
 * @param {any} body the parsed response body
 * @returns {{ok:true, build:{version:string,size:number,sha256:string,builtAt:string|null}}|{ok:false,reason:string}}
 */
export function validateAgentBuild(body) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'no metadata in the response' };
  if (body.ok !== true) return { ok: false, reason: 'the download route did not report ok' };
  if (typeof body.version !== 'string' || !VERSION.test(body.version)) {
    return { ok: false, reason: 'version is missing or not a version number' };
  }
  if (!Number.isInteger(body.size) || body.size <= 0) {
    return { ok: false, reason: 'size is missing or not a positive byte count' };
  }
  if (typeof body.sha256 !== 'string' || !HEX64.test(body.sha256)) {
    return { ok: false, reason: 'sha256 is missing or not a 64-character digest' };
  }
  return {
    ok: true,
    build: {
      version: body.version,
      size: body.size,
      sha256: body.sha256.toLowerCase(),
      builtAt: typeof body.builtAt === 'string' ? body.builtAt : null,
    },
  };
}

/** Numeric comparison. -1 / 0 / 1. "3.10.0" beats "3.4.0", which a string compare gets backwards. */
export function cmpVersion(a, b) {
  const parts = (x) => String(x || '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pa = parts(a); const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0; const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

/**
 * Everything the download control needs, derived from the request status alone — never from the
 * absence of data.
 *
 * @param {{status:string, build?:object|null, reason?:string|null, href:string}} input
 * @returns {{kind:string, label:string, title:string, href:string|null, enabled:boolean, retry:boolean}}
 */
export function downloadControl({ status, build, reason, href }) {
  switch (status) {
    case META.READY: {
      if (!build) {
        // READY without a build is a programming error, not a reason to offer a download.
        return { kind: META.INVALID, label: 'Installer unavailable', title: 'Installer metadata is missing.', href: null, enabled: false, retry: true };
      }
      return {
        kind: META.READY,
        label: `Download Windows Agent v${build.version}`,
        title: `v${build.version} · ${mb(build.size)} · SHA-256 ${build.sha256.slice(0, 16)}…`,
        href,
        enabled: true,
        retry: false,
      };
    }
    case META.UNPUBLISHED:
      return {
        kind: META.UNPUBLISHED,
        label: 'No installer published',
        title: 'The server has no published Windows installer, so there is nothing to download yet.',
        href: null, enabled: false, retry: true,
      };
    case META.INVALID:
      return {
        kind: META.INVALID,
        label: 'Installer metadata invalid',
        title: `The published metadata does not describe a usable installer: ${reason || 'unknown reason'}. No version is being claimed.`,
        href: null, enabled: false, retry: true,
      };
    case META.ERROR:
      return {
        kind: META.ERROR,
        label: 'Installer check failed',
        title: `Could not read the installer metadata: ${reason || 'request failed'}. The download is not offered because its version is unknown.`,
        href: null, enabled: false, retry: true,
      };
    case META.LOADING:
    default:
      return {
        kind: META.LOADING,
        label: 'Checking installer…',
        title: 'Reading the published installer metadata.',
        href: null, enabled: false, retry: false,
      };
  }
}

/**
 * Can the machine that reported in actually be updated? This is a statement about the PUBLISHED
 * installer, because that is the only thing an operator can install from this page.
 *
 * @param {{installedVersion?:string|null, publishedVersion?:string|null}} input
 * @returns {{kind:'update-available'|'up-to-date'|'ahead'|'unknown', text:string, tone:'warn'|'ok'|'mut'}}
 */
export function updateAvailability({ installedVersion, publishedVersion }) {
  if (!installedVersion) {
    return { kind: 'unknown', text: 'not known', tone: 'mut', detail: 'No agent has reported its version, so there is nothing to compare against the published installer.' };
  }
  if (!publishedVersion) {
    return { kind: 'unknown', text: 'not known', tone: 'mut', detail: 'The published installer version could not be read, so whether an update exists is unknown.' };
  }
  const c = cmpVersion(installedVersion, publishedVersion);
  if (c < 0) {
    return { kind: 'update-available', text: `update available → v${publishedVersion}`, tone: 'warn', detail: `The reporting machine runs v${installedVersion}; the public download serves v${publishedVersion}.` };
  }
  if (c === 0) {
    return { kind: 'up-to-date', text: 'matches the published installer', tone: 'ok', detail: `Both are v${publishedVersion}.` };
  }
  return { kind: 'ahead', text: `newer than the download (v${publishedVersion})`, tone: 'mut', detail: `The reporting machine runs v${installedVersion}, which is newer than the published v${publishedVersion}. Installing the published build would be a downgrade.` };
}

/**
 * One short line for the "Published installer" row — what the PUBLIC download would serve right
 * now, or why that is not known. Never a version number the metadata did not establish.
 *
 * @param {{status:string, build?:object|null, reason?:string|null}} meta
 * @returns {{text:string, title:string}}
 */
export function publishedSummary({ status, build, reason }) {
  switch (status) {
    case META.READY:
      return build
        ? { text: `v${build.version} · ${mb(build.size)}`, title: `SHA-256 ${build.sha256}${build.builtAt ? ` · built ${build.builtAt}` : ''}` }
        : { text: 'not known', title: 'Metadata was reported ready but carries no build.' };
    case META.UNPUBLISHED:
      return { text: 'none published', title: 'The server has no published Windows installer.' };
    case META.INVALID:
      return { text: 'metadata invalid', title: `The published metadata does not describe a usable installer: ${reason || 'unknown reason'}.` };
    case META.ERROR:
      return { text: 'check failed', title: `Could not read the installer metadata: ${reason || 'request failed'}.` };
    case META.LOADING:
    default:
      return { text: 'checking…', title: 'Reading the published installer metadata.' };
  }
}

/**
 * The server's EXPECTED_AGENT_VERSION is a policy constant, not a thing you can download. When it
 * disagrees with what the public route serves, the operator is looking at the cause of every
 * "update available to a version that will not install" report, and should be told so.
 *
 * @param {{expectedVersion?:string|null, publishedVersion?:string|null}} input
 * @returns {{mismatch:boolean, text:string}}
 */
export function expectationMismatch({ expectedVersion, publishedVersion }) {
  if (!expectedVersion || !publishedVersion) return { mismatch: false, text: '' };
  if (cmpVersion(expectedVersion, publishedVersion) === 0) return { mismatch: false, text: '' };
  return {
    mismatch: true,
    text: `this server expects agent v${expectedVersion}, but the public download serves v${publishedVersion}`,
  };
}
