import { useState, useEffect, useCallback, useRef } from 'react';
import AdminLayoutEnhanced from '../../components/AdminLayoutEnhanced';
import AdminProxyTools from './AdminProxyTools';
import {
  PenTool, Activity, RefreshCw, Loader2, Chrome, CheckCircle2, AlertTriangle,
  Server, Cpu, Clock, Zap, RotateCw, Play, ShieldCheck, Cookie, Wifi, WifiOff, Bell, Save, Download,
} from 'lucide-react';
import { writeHumanV2Admin } from '../../services/writeHumanV2Service';
import { withCsrfRetry } from '../../services/launchService';
import { getApiBaseUrl } from '../../services/api';
import { useToast } from '../../components/Toast';

// ── small presentational helpers ──────────────────────────────────────────────
const TONE = {
  ok: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  warn: 'bg-amber-50 text-amber-700 border border-amber-200',
  bad: 'bg-red-50 text-red-700 border border-red-200',
  mut: 'bg-slate-100 text-slate-600 border border-slate-200',
};
const Badge = ({ tone = 'mut', children }) => (
  <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-bold ${TONE[tone]}`}>{children}</span>
);
const rel = (iso) => { if (!iso) return 'never'; let s = (Date.now() - new Date(iso).getTime()) / 1000; if (s < 0) s = 0; return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
// Time UNTIL a future instant. `rel()` clamps negatives to zero and appends "ago", so using it on
// an expiry rendered a command that dies in ten minutes as "expires 0s ago".
const until = (iso) => { if (!iso) return '—'; const s = (new Date(iso).getTime() - Date.now()) / 1000; if (s <= 0) return 'expired'; return s < 60 ? `in ${Math.round(s)}s` : s < 3600 ? `in ${Math.round(s / 60)}m` : `in ${Math.round(s / 3600)}h`; };
// Numeric semver compare — "3.10.0" must beat "3.4.0", which a string compare gets backwards.
const atLeast = (v, min) => {
  const p = (x) => String(x || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const a = p(v); const b = p(min);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) > (b[i] || 0)) return true; if ((a[i] || 0) < (b[i] || 0)) return false; }
  return true;
};
const dur = (sec) => sec == null ? '—' : sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.round(sec / 60)}m` : `${Math.round(sec / 3600)}h`;

const StatCard = ({ icon: Icon, label, value, color }) => (
  <div className="ds-card rounded-xl p-4 flex items-center gap-3">
    <span className={`w-10 h-10 rounded-lg flex items-center justify-center text-white bg-gradient-to-br ${color}`}><Icon size={18} /></span>
    <div><p className="text-lg font-bold text-slate-800 leading-tight">{value ?? '—'}</p><p className="text-xs text-slate-500 mt-0.5">{label}</p></div>
  </div>
);
const Row = ({ k, children }) => (
  <div className="flex items-center justify-between gap-3 py-1.5 border-b border-slate-100 last:border-0 text-sm">
    <span className="text-slate-500">{k}</span><span className="font-semibold text-slate-700 text-right break-words">{children}</span>
  </div>
);
const Panel = ({ icon: Icon, title, tint = 'text-slate-500', children, right }) => (
  <div className="ds-card rounded-xl p-5">
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2"><Icon size={16} className={tint} /><h2 className="font-semibold text-slate-700 text-sm">{title}</h2></div>
      {right}
    </div>
    {children}
  </div>
);

const AdminWriteHuman = () => {
  const { showSuccess, showError } = useToast();
  const [state, setState] = useState(null);
  const [logs, setLogs] = useState([]);
  const [firstLoad, setFirstLoad] = useState(true);
  const [conn, setConn] = useState('connecting'); // connecting | live | offline | not_configured
  const [busy, setBusy] = useState('');
  const [alert, setAlert] = useState(null);       // { emailMasked, emailSet, enabled, source, smtpConfigured }
  const [alertEmail, setAlertEmail] = useState('');
  const [savingAlert, setSavingAlert] = useState(false);
  const [agentBuild, setAgentBuild] = useState(null);   // { version, sha256, size, downloadUrl }
  const timer = useRef(null);
  const logTick = useRef(0);

  const loadState = useCallback(async () => {
    try {
      const r = await writeHumanV2Admin.getState();
      setState(r.data); setConn('live');
    } catch (e) {
      const code = e.response?.data?.code;
      if (code === 'v2_not_configured') setConn('not_configured');
      else setConn('offline');
    } finally { setFirstLoad(false); }
  }, []);

  const loadLogs = useCallback(async () => {
    try { const r = await writeHumanV2Admin.getLogs(120); if (r.data && Array.isArray(r.data.events)) setLogs(r.data.events); } catch (_) {}
  }, []);

  const loadAlert = useCallback(async () => {
    try { const r = await writeHumanV2Admin.getAlertConfig(); setAlert(r.data); } catch (_) {}
  }, []);
  useEffect(() => { loadAlert(); }, [loadAlert]);
  // One-time fetch of the published installer's version + checksum for the download button.
  useEffect(() => {
    let alive = true;
    writeHumanV2Admin.getAgentBuild().then((r) => { if (alive && r.data?.ok) setAgentBuild(r.data); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Save recipient and/or enable-toggle. Empty email clears the dashboard override (env fallback).
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alertEmail.trim());
  const saveAlert = async (payload) => {
    try {
      setSavingAlert(true);
      const r = await writeHumanV2Admin.setAlertConfig(payload);
      setAlert(r.data);
      if (payload.email !== undefined) setAlertEmail('');
      showSuccess('Alert settings saved');
    } catch (e) { showError(e.response?.data?.error || 'Failed to save alert settings'); }
    finally { setSavingAlert(false); }
  };

  // Poll every 30s, logs every ~90s. It was 3s, which on an open dashboard is 1200 backend
  // requests an hour for a system whose state changes every few MINUTES - the account has hit its
  // process ceiling before, and a status page is a silly way to spend it. Device heartbeats are
  // 2-5 minutes apart, so 30s still shows a change within one heartbeat, and Refresh is immediate.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      await loadState();
      if (logTick.current % 3 === 0) await loadLogs();   // ~90s
      logTick.current += 1;
    };
    tick();
    timer.current = setInterval(tick, 30000);
    return () => { alive = false; if (timer.current) clearInterval(timer.current); };
  }, [loadState, loadLogs]);

  const revokeDevice = async (d) => {
    const name = d.name || d.deviceId;
    if (!window.confirm(`Revoke ${name}?\n\nIt loses the right to push cookies. The stored session stays exactly as it is — revoking a device never signs anyone out.`)) return;
    try {
      await writeHumanV2Admin.revokeDevice(d.deviceId);
      showSuccess(`${name} revoked`); loadState();
    } catch (e) {
      const code = e.response?.data?.code;
      if (code === 'ACTIVE_SOURCE_ONLY_DEVICE') {
        if (window.confirm(`${name} is the ONLY paired device and it supplies the session in use.\n\nRevoke anyway? The current cookies keep working, but nothing will be able to refresh them.`)) {
          try { await writeHumanV2Admin.revokeDevice(d.deviceId, true); showSuccess(`${name} revoked`); loadState(); }
          catch (e2) { showError(e2.response?.data?.error || 'Failed to revoke'); }
        }
      } else showError(e.response?.data?.error || 'Failed to revoke');
    }
  };

  const act = async (fn, okMsg) => {
    try { setBusy(okMsg); const r = await fn(); showSuccess(okMsg); loadState(); return r; }
    catch (e) { showError(e.response?.data?.error || e.response?.data?.code || 'Action failed'); }
    finally { setBusy(''); }
  };

  // Hand a device the active-source role on its NEXT verified sync (a short-lived intent, not a
  // permanent pin). This handler was referenced by the "Make active" button but never defined, so
  // every click threw `makeActive is not defined` and did nothing — which is why operators resorted
  // to revoking the current source to switch machines. The endpoint returns 409 DEVICE_REVOKED for a
  // revoked device; act() surfaces that to the user.
  const makeActive = async (d) => {
    const name = d.name || d.deviceId;
    await act(
      () => writeHumanV2Admin.makeActive(d.deviceId),
      `${name} will become the active source on its next verified sync`,
    );
  };

  // VERIFY SESSION — server-side only. No Chrome opens anywhere, no agent is contacted, and it
  // works while the source machine is switched off. The toast says what was actually proven.
  const verifySession = async () => {
    try {
      setBusy('Verifying the stored session…');
      const r = await writeHumanV2Admin.verifySession();
      const d = r.data || {};
      showSuccess(
        d.result === 'working'
          ? `Session verified server-side${d.canary === 'passed' ? ' (live check passed)' : ''}${d.maskedId ? ` — ${d.maskedId}` : ''}. No Chrome was opened.`
          : `Verify returned ${d.result}. No Chrome was opened.`,
      );
      loadState();
    } catch (e) { showError(e.response?.data?.error || e.response?.data?.code || 'Verification failed'); }
    finally { setBusy(''); }
  };

  // OPEN WRITEHUMAN CHROME — addressed to the ACTIVE SOURCE and nowhere else. If that machine is
  // offline the server refuses and says so; it never picks a different device, and it never falls
  // back to whatever computer the admin happens to be sitting at.
  const openChromeOnActiveSource = async (loginRequired = false) => {
    try {
      setBusy('Opening WriteHuman Chrome on the active source…');
      const r = await withCsrfRetry((headers) => writeHumanV2Admin.openChromeOnActiveSource(headers, { loginRequired }));
      const d = r.data || {};
      showSuccess(`Queued for ${d.targetDeviceName || d.targetDeviceId} only — no other machine can pick it up.`);
      loadState();
    } catch (e) {
      // The server's message is the operator-facing sentence, including the two exact wordings for
      // an offline active source. Surfaced verbatim rather than replaced with a generic failure.
      showError(e.response?.data?.error || 'Could not open Chrome on the active source');
    } finally { setBusy(''); }
  };

  const sendCommand = async (command, okMsg) => {
    try {
      setBusy(okMsg);
      const r = await withCsrfRetry((headers) => writeHumanV2Admin.command(command, headers));
      const d = r.data || {};
      showSuccess(`${okMsg} — addressed to ${d.targetDeviceName || d.targetDeviceId}`);
      loadState();
    } catch (e) { showError(e.response?.data?.error || e.response?.data?.code || 'Action failed'); }
    finally { setBusy(''); }
  };

  const a = state?.account || {};
  const ag = state?.agent || null;
  const v = a.verification || {};
  const health = state?.health || 'unknown';
  const healthTone = health === 'up' ? 'ok' : health === 'degraded' ? 'warn' : health === 'down' ? 'bad' : 'mut';

  // ── FIVE SEPARATE SIGNALS ───────────────────────────────────────────────────
  // Session / verification / agent / Chrome / cookie sync each come from the server with their own
  // state and their own reason, and are rendered independently. They are ALLOWED to disagree,
  // because in reality they do: an offline agent with a working session is normal, not an alarm.
  //
  // What is gone: the single tone that drove every card from one `health` value. An access token
  // that had aged out — which happens for part of every hour, because WriteHuman's token lives ~1h
  // and a backgrounded Chrome rotates it late — turned Session, Verification, Sync agent and
  // Cookie sync all amber at once and read as "working · unverified". Nothing was wrong. Token
  // rotation now shows up as "Verification: due" and the Session card stays green.
  const hs = state?.healthSignals || null;
  const sess = hs?.session?.state || null;
  const ver = hs?.verification?.state || null;
  const agentState = hs?.agent?.state || null;
  const chromeState = hs?.chrome?.state || null;
  const syncState = hs?.cookieSync?.state || null;

  const sessionLabel = sess === 'HEALTHY' ? 'healthy'
    : sess === 'REFRESHING' ? 'refreshing'
    : sess === 'LOGIN_REQUIRED' ? 'login required'
    : sess === 'ERROR' ? 'no session'
    : (a.sessionStatus || a.status || '—');
  const stTone = sess === 'HEALTHY' ? 'ok' : sess === 'REFRESHING' ? 'warn' : sess ? 'bad' : healthTone;

  const verLabel = ver === 'recent' ? `verified ${rel(a.lastVerifiedAt)}`
    : ver === 'due' ? 'verification due' : ver === 'failed' ? 'verification failed' : '—';
  const verTone = ver === 'recent' ? 'ok' : ver === 'due' ? 'mut' : ver === 'failed' ? 'bad' : 'mut';

  const agLabel = agentState === 'ONLINE' ? 'online' : agentState === 'RECONNECTING' ? 'reconnecting'
    : agentState === 'OFFLINE' ? 'offline' : 'unknown';
  const agTone = agentState === 'ONLINE' ? 'ok' : agentState === 'OFFLINE' ? 'warn' : agentState === 'RECONNECTING' ? 'warn' : 'mut';

  const cdpUp = chromeState === 'CONNECTED';
  const chromeLabel = chromeState === 'CONNECTED' ? 'connected' : chromeState === 'DISCONNECTED' ? 'disconnected' : 'unknown';
  const cdpTone = chromeState === 'CONNECTED' ? 'ok' : chromeState === 'DISCONNECTED' ? 'warn' : 'mut';

  const syncLabel = syncState === 'FRESH' ? 'fresh' : syncState === 'BEHIND' ? 'behind'
    : syncState === 'NEVER_SYNCED' ? 'never synced' : syncState === 'FAILED' ? 'failed' : '—';
  const syncTone = syncState === 'FRESH' ? 'ok' : syncState === 'FAILED' ? 'bad' : syncState ? 'warn' : 'mut';

  const loggedOut = sess === 'LOGIN_REQUIRED';
  const showBanner = !!sess && sess !== 'HEALTHY';
  // Multi-device view.
  const devices = state?.devices || [];
  const liveDevices = devices.filter((d) => !d.revoked);
  const activeSource = state?.activeSource || null;
  const activeSourceOnline = !!activeSource?.online;
  const frozen = state?.agentFrozenReport || null;   // last telemetry, known to be out of date
  const srcTone = !activeSource ? 'mut' : activeSource.online ? 'ok' : 'warn';
  const pendingCommands = state?.pendingCommands || [];
  // Can the active source actually ACCEPT a command? Addressed commands need an agent new enough to
  // validate their addressing, and the server refuses anything older. Checking it here means the
  // buttons are disabled with a reason, instead of looking available and then failing on click —
  // which is what happened when the backend demanded 3.4.0 while every field agent still ran 3.3.0.
  const activeDevice = devices.find((d) => d.deviceId === activeSource?.deviceId) || null;
  const activeAgentVersion = activeDevice?.agentVersion || (ag && ag.version) || null;
  const minCmdVersion = state?.commandMinAgentVersion || null;
  const commandsSupported = !minCmdVersion || atLeast(activeAgentVersion, minCmdVersion);
  const cmdBlockedReason = !activeSourceOnline
    ? 'Active source is offline. WriteHuman continues using the last verified session. Reconnect that source before opening Chrome.'
    : !commandsSupported
      ? `${activeSource?.name || 'The active source'} runs agent ${activeAgentVersion || 'an unknown version'}. Commands need ${minCmdVersion} or newer — update the agent on that machine.`
      : null;
  const canCommand = activeSourceOnline && commandsSupported;

  return (
    <AdminLayoutEnhanced>
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span className="w-11 h-11 rounded-xl flex items-center justify-center text-white bg-gradient-to-br from-cyan-500 to-blue-600"><PenTool size={22} /></span>
          <div>
            <h1 className="font-heading text-xl font-bold text-slate-800 flex items-center gap-2">WriteHuman
              {conn === 'live' && <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600"><Wifi size={13} /> live</span>}
              {conn === 'offline' && <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-500"><WifiOff size={13} /> offline</span>}
              {conn === 'not_configured' && <span className="text-xs font-semibold text-amber-600">not configured</span>}
              {conn === 'live' && state?.health && (
                <span className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full ${
                  state.health === 'up' ? 'bg-emerald-100 text-emerald-700'
                  : state.health === 'degraded' ? 'bg-amber-100 text-amber-700'
                  : state.health === 'down' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'}`}>
                  {state.health === 'up' ? 'healthy' : state.health}
                </span>
              )}
            </h1>
            <p className="text-sm text-slate-500">Live session, agent, cookie-sync &amp; diagnostics for the WriteHuman V2 proxy.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a href={`${getApiBaseUrl()}/downloads/writehuman-agent/windows/latest`} download
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-semibold text-white bg-gradient-to-r from-cyan-500 to-blue-600 hover:opacity-90"
            title={agentBuild ? `v${agentBuild.version} · ${agentBuild.size ? Math.round(agentBuild.size/1048576) : '?'} MB · SHA-256 ${agentBuild.sha256?.slice(0,16)}…` : 'Windows agent installer'}>
            <Download size={15} /> Download Windows Agent{agentBuild ? ` v${agentBuild.version}` : ''}
          </a>
          <button onClick={loadState} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-semibold text-white bg-slate-800 hover:bg-slate-700"><RefreshCw size={15} /> Refresh</button>
        </div>
      </div>

      {conn === 'not_configured' && (
        <div className="ds-card rounded-xl p-4 mb-5 border border-amber-200 bg-amber-50 text-amber-800 text-sm">
          The WriteHuman V2 service isn't wired to this dashboard yet. Set <code className="bg-amber-100 px-1.5 py-0.5 rounded">WRITEHUMAN_V2_ADMIN_KEY</code> (and optionally <code className="bg-amber-100 px-1.5 py-0.5 rounded">WRITEHUMAN_V2_URL</code>) in the backend env and restart.
        </div>
      )}
      {conn === 'offline' && !firstLoad && (
        <div className="ds-card rounded-xl p-4 mb-5 border border-red-200 bg-red-50 text-red-700 text-sm flex items-center gap-2"><AlertTriangle size={16} /> Can't reach the WriteHuman V2 service right now. Retrying…</div>
      )}
      {/* Lifecycle banner: the ONE clear state the operator acts on. LOGIN_REQUIRED is the only one
          that asks for action — everything else is informational and self-recovering. */}
      {/* The banner fires on SESSION health only. It used to fire on a combined lifecycle value, so
          an aged access token — routine, hourly, harmless — raised an amber "Refreshing the
          session…" alert on a perfectly healthy account. Verification being due is shown on its own
          card, quietly, where it belongs. */}
      {conn === 'live' && !firstLoad && showBanner && (
        <div className={`ds-card rounded-xl p-4 mb-5 border text-sm flex items-start justify-between gap-3 ${
          sess === 'LOGIN_REQUIRED' || sess === 'ERROR' ? 'border-red-200 bg-red-50 text-red-700'
          : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          <span className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
            <span>
              <strong>{sess === 'LOGIN_REQUIRED' ? 'WriteHuman login required' : sess === 'ERROR' ? 'No session saved' : 'Session refreshing'}:</strong> {hs?.session?.reason}
              {sess === 'LOGIN_REQUIRED' && !activeSourceOnline && (
                <em className="block mt-1 not-italic font-semibold">Login required, but the active source is currently offline.</em>
              )}
            </span>
          </span>
          {sess === 'LOGIN_REQUIRED' && (
            <button disabled={!!busy || !canCommand} onClick={() => openChromeOnActiveSource(true)}
              title={cmdBlockedReason || `Opens Chrome on ${activeSource?.name || 'the active source'} only`}
              className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-semibold text-white bg-gradient-to-r from-cyan-500 to-blue-600 disabled:opacity-50">
              <Chrome size={14} /> Open Chrome on {activeSource?.name || 'active source'}
            </button>
          )}
        </div>
      )}

      {/* An OFFLINE agent is information, not an alarm — the stored session keeps working. It gets
          a quiet grey note instead of the red/amber banner it used to share with real failures. */}
      {conn === 'live' && !firstLoad && sess === 'HEALTHY' && (agentState === 'OFFLINE' || syncState === 'BEHIND') && (
        <div className="ds-card rounded-xl p-3.5 mb-5 border border-slate-200 bg-slate-50 text-slate-600 text-[13px] flex items-start gap-2">
          <Server size={15} className="mt-0.5 flex-shrink-0" />
          <span>
            <strong>Session is healthy.</strong> {agentState === 'OFFLINE' ? 'The source agent is offline' : 'Cookie sync is behind'} — WriteHuman continues on the last verified session and refreshes on its own when the source returns. Nothing to do.
          </span>
        </div>
      )}

      {conn === 'live' && !firstLoad && state?.ingestConfigured === false && (
        <div className="ds-card rounded-xl p-4 mb-5 border border-red-200 bg-red-50 text-red-700 text-sm flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
          <span><strong>Cookie sync is switched off:</strong> no device is paired, so the server will refuse every push and this session can never refresh itself. Pair a device below to turn sync back on.</span>
        </div>
      )}
      {conn === 'live' && !firstLoad && state?.telemetryFrozen && (
        <div className="ds-card rounded-xl p-4 mb-5 border border-amber-200 bg-amber-50 text-amber-800 text-sm flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
          <span><strong>Device telemetry is out of date.</strong> The readings below (Chrome/CDP, sign-in) are from {rel(frozen?.reportAt || frozen?.receivedAt)} and are <em>not</em> current — the device stopped reporting. They describe how things were then, not now.</span>
        </div>
      )}

      {firstLoad ? (
        <div className="flex items-center justify-center py-20 text-slate-400"><Loader2 className="animate-spin mr-2" size={20} /> Loading…</div>
      ) : (
        <>
          {/* Big status stats */}
          {/* Six independent readings. Each shows ONE fact, and the wording says which fact it is:
              "Verification due" and "Agent telemetry stale" never claim the account has expired. */}
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 mb-5">
            <StatCard icon={ShieldCheck} label="Session" value={<Badge tone={stTone}>{sessionLabel}</Badge>} color="from-blue-500 to-cyan-500" />
            <StatCard icon={CheckCircle2} label="Verification" value={<Badge tone={verTone}>{verLabel}</Badge>} color="from-emerald-500 to-green-600" />
            <StatCard icon={Server} label="Active source" value={<Badge tone={srcTone}>{activeSource ? activeSource.name || activeSource.deviceId : 'none yet'}</Badge>} color="from-indigo-500 to-blue-600" />
            <StatCard icon={Activity} label="Agent" value={<Badge tone={agTone}>{agLabel}</Badge>} color="from-emerald-500 to-teal-500" />
            <StatCard icon={Chrome} label="Chrome / CDP" value={<Badge tone={cdpTone}>{chromeLabel}</Badge>} color="from-violet-500 to-fuchsia-500" />
            <StatCard icon={Cookie} label="Cookie sync" value={<Badge tone={syncTone}>{syncLabel}</Badge>} color="from-amber-500 to-orange-500" />
          </div>
          {hs?.summary && (
            <p className="text-[12.5px] text-slate-500 -mt-2 mb-5">{hs.summary}. <span className="text-slate-400">{hs.session?.reason}</span></p>
          )}

          {/* Paired devices — any of them may supply cookies; the newest VERIFIED bundle wins. */}
          {/* Read-only in normal operation. Agents enrol themselves on first sync, so there is
              nothing to click here to get a machine syncing - only things to look at, plus Revoke
              for taking a machine's access away. Manual pairing still exists server-side for
              rollback; it is deliberately not surfaced, because an admin control that is never
              needed is an admin control that gets pressed by mistake. */}
          <Panel icon={Server} title="Sync devices" tint="text-indigo-500" right={
            <span className="text-[12px] text-slate-500">agents enrol automatically &middot; no pairing needed</span>
          }>
            {liveDevices.length === 0 ? (
              <p className="text-sm text-slate-400 py-3">No agent has checked in yet. Install the Universal Agent on the machine where you sign in to WriteHuman; it registers itself on its first sync. Several machines can run it at once, and whichever has the freshest verified login becomes the source.</p>
            ) : (
              <div className="space-y-2">
                {liveDevices.map((d) => (
                  <div key={d.deviceId} className="flex items-center justify-between gap-3 p-3 rounded-lg border border-slate-150 bg-slate-50/60">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-800 text-sm flex items-center gap-2 flex-wrap">
                        {d.name || d.deviceId}
                        {d.isActiveSource && <Badge tone="ok">active source</Badge>}
                        {!d.isActiveSource && state?.pendingActiveDeviceId === d.deviceId && <Badge tone="warn">activating on next sync</Badge>}
                        {d.online ? <Badge tone="ok">online</Badge> : <Badge tone="warn">offline · {rel(d.lastSeenAt)}</Badge>}
                        {d.lastResultCode && d.lastResultCode !== 'PROMOTED' && d.lastResultCode !== 'HEARTBEAT' && d.lastResultCode !== 'COOKIE_BUNDLE_UNCHANGED' && <Badge tone="warn">{d.lastResultCode}</Badge>}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5 truncate">
                        {d.hostname || '—'} · agent {d.agentVersion || '?'} · {d.promotionCount || 0} promotions · last sync {rel(d.lastSyncSuccessAt)}
                        {d.cdp ? ` · cdp ${d.cdp}` : ''}{d.profile ? ` · profile ${d.profile}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {!d.isActiveSource && (
                        <button onClick={() => makeActive(d)} title="Hand this device the active-source role on its next verified sync"
                          className="px-3 py-1.5 rounded-lg text-[13px] font-semibold text-indigo-600 border border-indigo-200 hover:bg-indigo-50">Make active</button>
                      )}
                      <button onClick={() => revokeDevice(d)} className="px-3 py-1.5 rounded-lg text-[13px] font-semibold text-red-600 border border-red-200 hover:bg-red-50">Revoke</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4 mt-4">
            <Panel icon={Server} title="Active cookie source" tint="text-indigo-500">
              <Row k="Device">{activeSource ? (activeSource.name || activeSource.deviceId) : <Badge tone="mut">none yet</Badge>}</Row>
              <Row k="Device state">{!activeSource ? '—' : activeSource.online ? <Badge tone="ok">online</Badge> : <Badge tone="warn">offline — last verified bundle still in use</Badge>}</Row>
              <Row k="Promoted">{rel(activeSource?.promotedAt)}</Row>
              <Row k="Bundle version">{state?.bundleVersion ?? '—'}</Row>
              <Row k="Rollback kept">{state?.rollbackAvailable ? <Badge tone="ok">{state.rollbackAvailable}</Badge> : <Badge tone="mut">none</Badge>}</Row>
              <Row k="Devices paired">{liveDevices.length} · {state?.onlineDeviceCount ?? 0} online</Row>
            </Panel>

            <Panel icon={Cookie} title="Last candidate" tint="text-teal-500">
              {state?.candidate ? (<>
                <Row k="From">{state.candidate.deviceName || state.candidate.deviceId || '—'}</Row>
                <Row k="Received">{rel(state.candidate.receivedAt)}</Row>
                <Row k="Outcome"><Badge tone={state.candidate.status === 'promoted' ? 'ok' : state.candidate.status === 'validating' ? 'mut' : 'warn'}>{state.candidate.code || state.candidate.status}</Badge></Row>
                {state.candidate.code === 'ACCOUNT_MISMATCH' && (
                  <Row k="Identity">expected {state.candidate.expectedMaskedId || '—'} · got {state.candidate.observedMaskedId || '—'}</Row>
                )}
                <Row k="Hash">{state.candidate.hashPrefix ? <code className="text-xs">{state.candidate.hashPrefix}</code> : '—'}</Row>
              </>) : <p className="text-sm text-slate-400 py-3">No candidate has been offered yet.</p>}
            </Panel>

            <Panel icon={ShieldCheck} title="Session & account" tint="text-blue-500">
              <Row k="Account">{a.label || '—'}</Row>
              <Row k="Overall"><Badge tone={healthTone}>{health === 'up' ? 'healthy' : health}</Badge></Row>
              <Row k="Session"><Badge tone={stTone}>{sessionLabel}</Badge></Row>
              <Row k="Sign-in">{a.browserAuthCookies == null
                ? <Badge tone="mut">{a.telemetryFrozen ? 'unknown · no device reporting' : 'unknown'}</Badge>
                : loggedOut ? <Badge tone="bad">signed out</Badge> : <Badge tone="ok">signed in</Badge>}</Row>
              <Row k="Stored status">{a.status || '—'} / {a.sessionStatus || '—'}</Row>
              <Row k="Cookies stored">{a.cookieCount ?? '—'}</Row>
              <Row k="Bundle present">{a.hasBundle ? <Badge tone="ok">yes</Badge> : <Badge tone="warn">no</Badge>}</Row>
              {/* An aged access token is ROUTINE — the token lives ~1h and rotates. What actually
                  matters is whether the refresh half is still there, so both are shown and the
                  aged case reads "rotating", not "expired". */}
              <Row k="Access token">{a.accessTokenExpiresInSec == null ? '—'
                : a.accessTokenExpiresInSec <= 0 ? <Badge tone="mut">rotating</Badge>
                : `valid ~${dur(a.accessTokenExpiresInSec)}`}</Row>
              <Row k="Refresh session">{state?.refreshTokenPresent == null ? '—'
                : state.refreshTokenPresent ? <Badge tone="ok">present</Badge> : <Badge tone="bad">missing</Badge>}</Row>
            </Panel>

            <Panel icon={CheckCircle2} title="Verification" tint="text-emerald-500">
              <Row k="Freshness"><Badge tone={verTone}>{verLabel}</Badge></Row>
              <Row k="Result">{v.result ? <Badge tone={v.result === 'working' ? 'ok' : v.result === 'session_expired' ? 'bad' : 'mut'}>{v.result}</Badge> : '—'}</Row>
              <Row k="Account (masked)">{v.maskedId || '—'}</Row>
              <Row k="HTTP">{v.httpStatus ?? '—'}</Row>
              <Row k="Last verification">{rel(a.lastVerifiedAt)}</Row>
              {hs?.verification?.reason && <p className="text-[11.5px] text-slate-400 mt-2">{hs.verification.reason}</p>}
            </Panel>

            <Panel icon={Cookie} title="Cookie sync" tint="text-amber-500">
              <Row k="Last sync">{rel(a.lastSyncedAt)}</Row>
              <Row k="Sync count">{a.syncCount ?? '—'}</Row>
              <Row k="Staleness">{a.staleSec == null ? '—' : dur(a.staleSec)}</Row>
              <Row k="Cookie hash">{a.hasCookieHash ? <Badge tone="ok">present</Badge> : <Badge tone="warn">none</Badge>}</Row>
            </Panel>

            <Panel icon={Cpu} title="Agent diagnostics" tint="text-violet-500">
              {ag ? (<>
                <Row k="Host">{ag.host || '—'}</Row>
                <Row k="Agent version">{ag.version || '—'} {state?.agentOutdated ? <Badge tone="warn">update available → {state.expectedAgentVersion}</Badge> : state?.agentOutdated === false ? <Badge tone="ok">latest</Badge> : null}</Row>
                <Row k="CDP / Chrome">{cdpUp ? <Badge tone="ok">cdp 200</Badge> : <Badge tone="bad">cdp {ag.cdp || '?'}</Badge>} {ag.chrome ? <Badge tone="ok">chrome</Badge> : <Badge tone="warn">no chrome</Badge>}</Row>
                <Row k="Polls · auth cookies">{(ag.pollCount ?? '—') + ' · ' + (ag.authCookies ?? '—')}</Row>
                <Row k="Uptime">{dur(ag.uptimeSec)}</Row>
                <Row k="Last error">{ag.lastError
                  ? <span className="text-amber-700">{ag.lastError}<span className="text-slate-400 font-normal"> · {rel(ag.lastErrorAt)}{ag.errorCount > 1 ? ` · ${ag.errorCount}×` : ''}</span></span>
                  : <Badge tone="ok">none</Badge>}</Row>
                <Row k="Last report">{rel(ag.receivedAt)}</Row>
              </>) : <p className="text-sm text-slate-400 py-3">No agent report yet — the Cookie Sync Agent hasn't checked in.</p>}
            </Panel>

            <Panel icon={Server} title="System / health" tint="text-slate-500">
              <Row k="Mode">{state?.mode || '—'}</Row>
              <Row k="Target">{state?.target || '—'}</Row>
              <Row k="Store">{state?.store || '—'}</Row>
              <Row k="Smart timer">{state?.scheduler?.running ? <Badge tone="ok">running · {state.scheduler.intervalMin}m</Badge> : <Badge tone="warn">off</Badge>}</Row>
              <Row k="Verify exchange">{state?.verifyExchange ? <Badge tone="warn">on</Badge> : <Badge tone="ok">off (read-only)</Badge>}</Row>
            </Panel>

            <Panel icon={Bell} title="Health alerts" tint="text-rose-500">
              {alert ? (<>
                <Row k="Alert email">{alert.emailSet
                  ? <span className="inline-flex items-center gap-1.5">{alert.emailMasked} {alert.source === 'db' ? <Badge tone="ok">dashboard</Badge> : <Badge tone="mut">server default</Badge>}</span>
                  : <Badge tone="warn">not set</Badge>}</Row>
                <Row k="Alerts">{alert.enabled ? <Badge tone="ok">on</Badge> : <Badge tone="mut">off</Badge>}</Row>
                <Row k="Email delivery">{alert.smtpConfigured ? <Badge tone="ok">SMTP ready</Badge> : <Badge tone="warn">not configured</Badge>}</Row>
                <div className="mt-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <input type="email" value={alertEmail} onChange={(e) => setAlertEmail(e.target.value)} autoComplete="off"
                      placeholder={alert.emailSet ? 'Change alert email…' : 'Enter alert email…'}
                      className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-rose-200" />
                    <button disabled={savingAlert || !emailValid} onClick={() => saveAlert({ email: alertEmail.trim(), enabled: true })}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-semibold text-white bg-gradient-to-r from-rose-500 to-pink-500 disabled:opacity-50"><Save size={15} /> Save</button>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <label className="inline-flex items-center gap-2 text-[13px] text-slate-600 cursor-pointer">
                      <input type="checkbox" checked={!!alert.enabled} disabled={savingAlert || !alert.emailSet}
                        onChange={(e) => saveAlert({ enabled: e.target.checked })} className="rounded" /> Enable alert emails
                    </label>
                    {alert.emailSet && alert.source === 'db' && (
                      <button disabled={savingAlert} onClick={() => saveAlert({ email: '' })}
                        className="text-[12px] text-slate-400 hover:text-slate-600 disabled:opacity-50">Clear override</button>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400">Emails on session down / recovered / agent stale. The full address is stored securely and never shown in full.</p>
                </div>
              </>) : <p className="text-sm text-slate-400 py-3">Loading…</p>}
            </Panel>

            <Panel icon={Zap} title="Actions" tint="text-cyan-500">
              <p className="text-[12px] text-slate-400 mb-3">
                <strong className="text-slate-500">Verify Session</strong> checks the stored session on the server — it opens no browser anywhere and works while the source machine is off.
                Only <strong className="text-slate-500">Open WriteHuman Chrome</strong> starts a browser, and only on the active source.
              </p>
              <div className="flex flex-wrap gap-2">
                <button disabled={!!busy || conn !== 'live'} onClick={verifySession}
                  title="Server-side check of the stored bundle. No Chrome opens on any machine."
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-semibold text-white bg-gradient-to-r from-blue-600 to-cyan-500 disabled:opacity-50"><ShieldCheck size={15} /> Verify Session</button>
                <button disabled={!!busy || conn !== 'live' || !canCommand} onClick={() => sendCommand('resync', 'Re-sync queued')}
                  title={cmdBlockedReason || 'Ask the active source to re-read and push its cookies'}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50"><RotateCw size={15} /> Re-sync</button>
                <button disabled={!!busy || conn !== 'live' || !canCommand} onClick={() => sendCommand('rotate-token', 'Token rotation requested')}
                  title={cmdBlockedReason || "Ask the active source's browser to rotate the access token now. No browser is launched."}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50"><RefreshCw size={15} /> Rotate token</button>
                <button disabled={!!busy || conn !== 'live' || !canCommand} onClick={() => openChromeOnActiveSource(false)}
                  title={cmdBlockedReason || `Opens Chrome on ${activeSource?.name || 'the active source'} — and nowhere else`}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-semibold text-cyan-700 bg-white border border-cyan-200 hover:bg-cyan-50 disabled:opacity-50"><Play size={15} /> Open WriteHuman Chrome on Active Source</button>
              </div>
              {cmdBlockedReason && activeSource && (
                <p className={`text-[12px] mt-3 ${commandsSupported ? 'text-slate-500' : 'text-amber-700'}`}>{cmdBlockedReason}</p>
              )}
              {pendingCommands.length > 0 && (
                <div className="mt-3 space-y-1">
                  {pendingCommands.map((c) => (
                    <p key={c.id} className="text-[12px] text-amber-600 flex items-center gap-1">
                      <Clock size={12} /> {c.type} → <strong>{c.targetDeviceName || c.targetDeviceId}</strong> only · expires {until(c.expiresAt)}
                    </p>
                  ))}
                </div>
              )}
            </Panel>
          </div>

          {/* Live logs */}
          <div className="ds-card rounded-xl p-5 mt-4">
            <div className="flex items-center gap-2 mb-3"><Activity size={16} className="text-slate-500" /><h2 className="font-semibold text-slate-700 text-sm">Live logs</h2><span className="text-[11px] text-slate-400">({logs.length} events)</span></div>
            <div className="bg-slate-900 rounded-lg p-3 max-h-80 overflow-auto font-mono text-[12px] leading-relaxed">
              {logs.length === 0 ? <p className="text-slate-500">No events yet.</p> : logs.slice().reverse().map((e) => (
                <div key={e.seq} className="whitespace-pre-wrap">
                  <span className="text-slate-500">{new Date(e.t).toLocaleTimeString()}</span>{' '}
                  <span className={e.level === 'error' ? 'text-red-300' : e.level === 'warn' ? 'text-amber-300' : 'text-cyan-300'}>{e.event}</span>{' '}
                  <span className="text-slate-500">{JSON.stringify(e.fields)}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Full WriteHuman management in its OWN section — account vault + client assignment.
          Reuses the Proxy-Tools management UI locked to WriteHuman (embedded, no extra layout),
          reading/writing the SAME MySQL ProxyAccount vault + ProxyClient assignments as the live
          status above. Single source of truth; no separate store, no duplicate UI. */}
      <div className="mt-8 pt-6 border-t border-slate-200">
        <AdminProxyTools fixedTool="writehuman" embedded />
      </div>
    </AdminLayoutEnhanced>
  );
};

export default AdminWriteHuman;
