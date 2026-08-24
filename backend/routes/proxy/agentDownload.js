'use strict';
/**
 * Public download for the WriteHuman Universal Agent installer.
 *
 * Public on purpose, and safe to be: the installer carries NO secret. It cannot sync anything on
 * its own — a fresh agent still has to enrol through the browser and be approved by an authenticated
 * admin before it receives a credential. So the value in gating the binary is nil, while the cost of
 * gating it (the admin page needing an authenticated blob fetch instead of a plain link) is real.
 *
 * The installer file itself lives OUTSIDE the versioned build tree, at WH_AGENT_DIST_DIR (default
 * ~/writehuman-agent), so a code deploy never has to carry a 90 MB binary and the file survives
 * deploys untouched. Metadata (version, sha256, size) is read from latest.json beside it.
 *
 * Never returns anything but the file and its public metadata; no cookies, no account data.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const router = express.Router();

const DIST_DIR = process.env.WH_AGENT_DIST_DIR || path.join(os.homedir(), 'writehuman-agent');
const EXE_NAME = 'WriteHuman-Agent-Setup-x64.exe';

function readMeta() {
  try { return JSON.parse(fs.readFileSync(path.join(DIST_DIR, 'latest.json'), 'utf8')); }
  catch (_) { return null; }
}

// Version + checksum for the admin page to display. No binary, cheap, cacheable.
router.get('/windows/latest.json', (req, res) => {
  const meta = readMeta();
  if (!meta) return res.status(404).json({ ok: false, error: 'no build published' });
  res.set('Cache-Control', 'no-cache');
  return res.json({ ok: true, ...meta, downloadUrl: '/api/crm/downloads/writehuman-agent/windows/latest' });
});

// The installer itself, streamed with a real filename and a checksum header so a client can verify.
router.get('/windows/latest', (req, res) => {
  const exePath = path.join(DIST_DIR, EXE_NAME);
  const meta = readMeta();
  if (!fs.existsSync(exePath)) return res.status(404).json({ ok: false, error: 'installer not published' });
  const versioned = meta && meta.version ? `WriteHuman-Agent-Setup-${meta.version}-x64.exe` : EXE_NAME;
  res.set('Content-Type', 'application/vnd.microsoft.portable-executable');
  res.set('Content-Disposition', `attachment; filename="${versioned}"`);
  if (meta && meta.sha256) res.set('X-Agent-SHA256', meta.sha256);
  if (meta && meta.version) res.set('X-Agent-Version', meta.version);
  res.set('Cache-Control', 'no-cache');
  return res.sendFile(exePath, (err) => {
    if (err && !res.headersSent) res.status(500).end();
  });
});

module.exports = router;
