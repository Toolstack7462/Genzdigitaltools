// A SOURCE CONTRACT FOR THE TWO DEFECTS THIS CHANGE EXISTS TO FIX.
//
// The behaviour lives in agentBuildMeta.js and writeHumanStateLabels.js, which are tested directly
// (48 tests). What those cannot catch is the page quietly going back to deciding things inline —
// which is exactly how both defects arose. So this pins the WIRING:
//
//   1. the download link is rendered only when the metadata request says a build is published;
//   2. installer metadata is re-read by the deliberate Refresh path, and NOT by the 30s poll;
//   3. no surface falls back to the bare word "unknown";
//   4. the device badge, the agent signal and the Chrome signal come from the tested module.
//
// Every assertion below fails against the previously deployed page.
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'AdminWriteHuman.js'), 'utf8');

describe('the download control is driven by the metadata status', () => {
  test('the page uses the tested module rather than deciding inline', () => {
    expect(SRC).toMatch(/from '\.\/agentBuildMeta'/);
    expect(SRC).toMatch(/downloadControl\(\{/);
    expect(SRC).toMatch(/validateAgentBuild\(r\.data\)/);
  });

  test('the anchor is conditional on dl.enabled', () => {
    // Previously: an unconditional <a href={…/windows/latest} download> on every render.
    expect(SRC).toMatch(/\{dl\.enabled \? \(/);
    expect(SRC).toMatch(/<a href=\{dl\.href\} download/);
  });

  test('the download href is never built straight into the anchor any more', () => {
    expect(SRC).not.toMatch(/<a href=\{`\$\{getApiBaseUrl\(\)\}\/downloads/);
  });

  test('the label and title come from the control, not from a truthiness test on the metadata', () => {
    expect(SRC).not.toMatch(/agentBuild \? ` v\$\{agentBuild\.version\}` : ''/);
    expect(SRC).not.toMatch(/\bsetAgentBuild\b/);
  });

  test('a non-published state offers a retry instead of a dead link', () => {
    expect(SRC).toMatch(/onClick=\{dl\.retry \? loadAgentBuild : undefined\}/);
  });
});

describe('metadata is refreshed deliberately, and not by polling', () => {
  test('Refresh re-reads state, logs AND the installer metadata', () => {
    expect(SRC).toMatch(/const refreshAll = useCallback\(\(\) => \{ loadState\(\); loadLogs\(\); loadAgentBuild\(\); \}/);
    expect(SRC).toMatch(/onClick=\{refreshAll\}/);
  });

  test('the 30s poll still polls only state and logs — no installer request was added', () => {
    const tick = SRC.slice(SRC.indexOf('const tick = async () =>'), SRC.indexOf('startVisiblePolling(tick'));
    expect(tick).toMatch(/loadState\(\)/);
    expect(tick).not.toMatch(/loadAgentBuild/);
  });

  test('no new interval or timeout was introduced for the installer check', () => {
    const metaBlock = SRC.slice(SRC.indexOf('const loadAgentBuild'), SRC.indexOf('const refreshAll'));
    expect(metaBlock).not.toMatch(/setInterval|setTimeout|startVisiblePolling/);
  });

  test('the installer check reads latest.json only — the 92MB exe is never fetched to check', () => {
    expect(SRC).toMatch(/writeHumanV2Admin\.getAgentBuild\(\)/);
    // The only other reference to the download route is the anchor the operator clicks.
    expect((SRC.match(/windows\/latest\b/g) || []).length).toBe(1);
  });

  test('a stale in-flight metadata response cannot overwrite a newer one', () => {
    expect(SRC).toMatch(/const metaGate = useRef\(createLatestOnly\(\)\)/);
    expect(SRC).toMatch(/metaGate\.current\.accept\(ticket\)/);
  });

  test('404 "no build published" is handled apart from a failed request', () => {
    expect(SRC).toMatch(/status === 404/);
    expect(SRC).toMatch(/META\.UNPUBLISHED/);
    expect(SRC).toMatch(/META\.ERROR/);
  });
});

describe('no surface falls back to the bare word "unknown"', () => {
  test("the device badge no longer prints (d.state || 'unknown')", () => {
    expect(SRC).not.toMatch(/d\.state \|\| 'unknown'/);
    expect(SRC).toMatch(/deviceStateBadge\(d\)/);
  });

  test('the agent and Chrome cards use the tested signal mapping', () => {
    expect(SRC).toMatch(/agentSignalBadge\(hs\?\.agent\)/);
    expect(SRC).toMatch(/chromeSignalBadge\(hs\?\.chrome\)/);
    expect(SRC).not.toMatch(/const agLabel =/);
    expect(SRC).not.toMatch(/const chromeLabel =/);
  });

  test('the sign-in row uses the tested mapping', () => {
    expect(SRC).toMatch(/signInBadge\(a, loggedOut\)/);
    expect(SRC).not.toMatch(/'unknown · no device reporting'/);
  });

  test("the only remaining 'unknown' literals are the server's own health vocabulary", () => {
    // state.health is a backend tri-state whose own value can be the string 'unknown'; that is the
    // server's word, echoed, not a fallback this page invented.
    const hits = SRC.split('\n').filter((l) => /'unknown'/.test(l));
    expect(hits.length).toBe(1);
    expect(hits[0]).toMatch(/state\?\.health \|\| 'unknown'/);
  });

  test('the local device-state tone map is gone — one source of tone, not two', () => {
    // The page kept its own copy with REVOKED: 'bad', which contradicted the module.
    expect(SRC).not.toMatch(/const STATE_TONE = \{/);
  });
});

describe('installed, published and update-available are three separate rows', () => {
  test('each has its own line and its own source', () => {
    expect(SRC).toMatch(/<Row k="Agent version">\{ag\.version \|\| '—'\}<\/Row>/);
    expect(SRC).toMatch(/<Row k="Published installer">\{published\.text\}<\/Row>/);
    expect(SRC).toMatch(/<Row k="Update">/);
  });

  test('the old merged claim is gone', () => {
    expect(SRC).not.toMatch(/update available → \{state\.expectedAgentVersion\}/);
  });

  test("the server's expected version is only shown as a named policy mismatch", () => {
    expect(SRC).toMatch(/expectationMismatch\(\{ expectedVersion: state\?\.expectedAgentVersion/);
    expect(SRC).toMatch(/mismatch\.mismatch && \(/);
  });

  test('update availability is computed from the PUBLISHED version, not the constant', () => {
    expect(SRC).toMatch(/updateAvailability\(\{ installedVersion: ag\?\.version \|\| null, publishedVersion: agentMeta\.build\?\.version \|\| null \}\)/);
  });
});
