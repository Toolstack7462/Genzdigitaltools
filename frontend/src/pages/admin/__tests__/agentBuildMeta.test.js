// THE DASHBOARD MAY NOT NAME A VERSION IT HAS NOT ESTABLISHED.
//
// Production is the reason these exist. The public route serves 3.5.3; the backend constant
// EXPECTED_AGENT_VERSION said something else; and the page rendered "Download Windows Agent" with
// no version at all whenever the metadata request had not answered — enabled, pointing at the
// download route, indistinguishable from the published case.
//
// Each test below starts from a state the deployed page got wrong.
import {
  META, validateAgentBuild, cmpVersion, downloadControl,
  publishedSummary, updateAvailability, expectationMismatch,
} from '../agentBuildMeta';

// The real body production serves, read from latest.json on the host.
const LIVE = {
  ok: true,
  product: 'WriteHuman Universal Agent',
  file: 'WriteHuman-Agent-Setup-x64.exe',
  version: '3.5.3',
  size: 91700224,
  sha256: '08d3cf7cf85fe667ec9f07fb951c1ecc11601b832b0c5acf0d5a8311675732a6',
  arch: 'x64',
  signed: false,
  builtAt: '2026-10-10T14:52:11.696Z',
};
const HREF = 'https://api.example.com/api/crm/downloads/writehuman-agent/windows/latest';

describe('metadata is validated before anything is shown', () => {
  test('the live production body validates, and is reported exactly as published', () => {
    const v = validateAgentBuild(LIVE);
    expect(v.ok).toBe(true);
    expect(v.build).toEqual({
      version: '3.5.3', size: 91700224,
      sha256: '08d3cf7cf85fe667ec9f07fb951c1ecc11601b832b0c5acf0d5a8311675732a6',
      builtAt: '2026-10-10T14:52:11.696Z',
    });
  });

  test('a body with a version but no size or digest is REJECTED', () => {
    // This is the shape that produced a confident "Download Windows Agent v3.5.15" over bytes
    // nobody had checked.
    expect(validateAgentBuild({ ok: true, version: '3.5.15' }).ok).toBe(false);
    expect(validateAgentBuild({ ok: true, version: '3.5.15', size: 91807232 }).ok).toBe(false);
  });

  test('ok:false is not usable metadata, whatever else it carries', () => {
    expect(validateAgentBuild({ ...LIVE, ok: false }).ok).toBe(false);
    expect(validateAgentBuild({ ...LIVE, ok: undefined }).ok).toBe(false);
  });

  test('a size of zero or a non-integer size is rejected', () => {
    for (const size of [0, -1, 1.5, '91700224', null, undefined]) {
      expect(validateAgentBuild({ ...LIVE, size }).ok).toBe(false);
    }
  });

  test('a digest that is not 64 hex characters is rejected', () => {
    for (const sha256 of ['', 'abc', LIVE.sha256.slice(0, 63), `${LIVE.sha256}0`, 'z'.repeat(64), null]) {
      expect(validateAgentBuild({ ...LIVE, sha256 }).ok).toBe(false);
    }
  });

  test('a version that is not a version number is rejected', () => {
    for (const version of ['latest', '3.5', 'v3.5.3', '', null, 3]) {
      expect(validateAgentBuild({ ...LIVE, version }).ok).toBe(false);
    }
    expect(validateAgentBuild({ ...LIVE, version: '3.5.15-retry-rc1' }).ok).toBe(true);
  });

  test('a missing builtAt is null, not an invented timestamp', () => {
    expect(validateAgentBuild({ ...LIVE, builtAt: undefined }).build.builtAt).toBeNull();
  });

  test('nothing at all is rejected without throwing', () => {
    for (const body of [null, undefined, '', 0, [], 'ok']) expect(validateAgentBuild(body).ok).toBe(false);
  });
});

describe('the download control distinguishes the four non-published cases', () => {
  test('LOADING offers nothing to click and says it is checking', () => {
    const c = downloadControl({ status: META.LOADING, href: HREF });
    expect(c.enabled).toBe(false);
    expect(c.href).toBeNull();
    expect(c.label).toMatch(/checking/i);
    expect(c.label).not.toMatch(/\bv?\d+\.\d+\.\d+/);  // no version claimed
  });

  test('UNPUBLISHED says so — it does NOT render an enabled download', () => {
    // The deployed page rendered an enabled link here, so clicking it downloaded the 404 body.
    const c = downloadControl({ status: META.UNPUBLISHED, href: HREF });
    expect(c.enabled).toBe(false);
    expect(c.href).toBeNull();
    expect(c.label).toMatch(/no installer published/i);
    expect(c.retry).toBe(true);
  });

  test('INVALID names the reason and claims no version', () => {
    const c = downloadControl({ status: META.INVALID, reason: 'sha256 is missing or not a 64-character digest', href: HREF });
    expect(c.enabled).toBe(false);
    expect(c.title).toMatch(/sha256 is missing/);
    expect(c.label).not.toMatch(/\d+\.\d+\.\d+/);
  });

  test('ERROR is reported as a failed check, not as "nothing published"', () => {
    const c = downloadControl({ status: META.ERROR, reason: 'Network Error', href: HREF });
    expect(c.enabled).toBe(false);
    expect(c.kind).toBe(META.ERROR);
    expect(c.title).toMatch(/Network Error/);
    expect(c.label).not.toMatch(/no installer published/i);
  });

  test('READY is the ONLY state with a live href, and it carries the real version', () => {
    const c = downloadControl({ status: META.READY, build: validateAgentBuild(LIVE).build, href: HREF });
    expect(c.enabled).toBe(true);
    expect(c.href).toBe(HREF);
    expect(c.label).toBe('Download Windows Agent v3.5.3');
    expect(c.title).toContain('87.5 MB');
    expect(c.title).toContain('08d3cf7cf85fe667');
  });

  test('READY without a build does not offer a download', () => {
    const c = downloadControl({ status: META.READY, build: null, href: HREF });
    expect(c.enabled).toBe(false);
  });

  test('an unrecognised status falls back to loading, never to enabled', () => {
    expect(downloadControl({ status: 'something-else', href: HREF }).enabled).toBe(false);
  });
});

describe('update availability is about the PUBLISHED installer, not a server constant', () => {
  test('installed older than published: an update is genuinely available', () => {
    const u = updateAvailability({ installedVersion: '3.5.2', publishedVersion: '3.5.3' });
    expect(u.kind).toBe('update-available');
    expect(u.text).toContain('3.5.3');
  });

  test('installed equals published: up to date', () => {
    expect(updateAvailability({ installedVersion: '3.5.3', publishedVersion: '3.5.3' }).kind).toBe('up-to-date');
  });

  test('installed NEWER than published is not an update — it would be a downgrade', () => {
    // The live case if 3.5.15 is installed on a machine while the download still serves 3.5.3.
    const u = updateAvailability({ installedVersion: '3.5.15', publishedVersion: '3.5.3' });
    expect(u.kind).toBe('ahead');
    expect(u.detail).toMatch(/downgrade/i);
  });

  test('either side missing is "not known", never "up to date"', () => {
    expect(updateAvailability({ installedVersion: null, publishedVersion: '3.5.3' }).kind).toBe('unknown');
    expect(updateAvailability({ installedVersion: '3.5.3', publishedVersion: null }).kind).toBe('unknown');
    expect(updateAvailability({}).kind).toBe('unknown');
  });

  test('comparison is numeric: 3.10.0 is newer than 3.4.0', () => {
    expect(cmpVersion('3.10.0', '3.4.0')).toBe(1);
    expect(cmpVersion('3.5.15', '3.5.3')).toBe(1);   // the exact pair this task is about
    expect(cmpVersion('3.5.3', '3.5.15')).toBe(-1);
    expect(cmpVersion('3.5.3', '3.5.3')).toBe(0);
  });

  test('a prerelease suffix does not break the comparison', () => {
    expect(cmpVersion('3.5.15-retry-rc1', '3.5.3')).toBe(1);
  });
});

describe("the server's expectation and the published build are reported separately", () => {
  test('the production disagreement is named outright', () => {
    const m = expectationMismatch({ expectedVersion: '3.5.15', publishedVersion: '3.5.3' });
    expect(m.mismatch).toBe(true);
    expect(m.text).toContain('3.5.15');
    expect(m.text).toContain('3.5.3');
  });

  test('agreement produces no warning', () => {
    expect(expectationMismatch({ expectedVersion: '3.5.3', publishedVersion: '3.5.3' }).mismatch).toBe(false);
  });

  test('an unknown published version is not reported as a mismatch', () => {
    // Nothing has been established, so there is nothing to contradict.
    expect(expectationMismatch({ expectedVersion: '3.5.15', publishedVersion: null }).mismatch).toBe(false);
    expect(expectationMismatch({ expectedVersion: null, publishedVersion: '3.5.3' }).mismatch).toBe(false);
  });
});

describe('the published-installer line never invents a version', () => {
  test('READY shows version and size, with the digest in the title', () => {
    const p = publishedSummary({ status: META.READY, build: validateAgentBuild(LIVE).build });
    expect(p.text).toBe('v3.5.3 · 87.5 MB');
    expect(p.title).toContain(LIVE.sha256);
  });

  test('every non-ready status names itself and carries no version', () => {
    for (const status of [META.LOADING, META.UNPUBLISHED, META.INVALID, META.ERROR]) {
      const p = publishedSummary({ status, reason: 'because' });
      expect(p.text).not.toMatch(/\d+\.\d+\.\d+/);
      expect(p.text.length).toBeGreaterThan(3);
    }
    expect(publishedSummary({ status: META.UNPUBLISHED }).text).toMatch(/none published/i);
    expect(publishedSummary({ status: META.ERROR }).text).toMatch(/check failed/i);
  });
});
