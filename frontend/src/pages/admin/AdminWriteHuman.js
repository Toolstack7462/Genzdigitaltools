import { useState, useEffect, useCallback, useRef } from 'react';
import AdminLayoutEnhanced from '../../components/AdminLayoutEnhanced';
import AdminProxyTools from './AdminProxyTools';
import {
  PenTool, Activity, RefreshCw, Loader2, Chrome, CheckCircle2, AlertTriangle,
  Server, Cpu, Clock, Zap, RotateCw, Play, ShieldCheck, Cookie, Wifi, WifiOff, Bell, Save,
} from 'lucide-react';
import { writeHumanV2Admin } from '../../services/writeHumanV2Service';
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
  // Pairing: the code is returned ONCE by the server and is never retrievable again, so it lives
  // in component state only until the operator dismisses it. It is never persisted or logged.
  const [pairCode, setPairCode] = useState(null);   // { code, name, expiresAt }
  const [pairName, setPairName] = useState('');
  const [pairing, setPairing] = useState(false);
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

  // Poll: state every 3s (near-real-time), logs every ~9s. Reliable through the double reverse-proxy.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      await loadState();
      if (logTick.current % 3 === 0) await loadLogs();
      logTick.current += 1;
    };
    tick();
    timer.current = setInterval(tick, 3000);
    return () => { alive = false; if (timer.current) clearInterval(timer.current); };
  }, [loadState, loadLogs]);

  const createPairCode = async () => {
    try {
      setPairing(true);
      const r = await writeHumanV2Admin.createPairCode(pairName.trim() || undefined);
      setPairCode(r.data); setPairName('');
    } catch (e) { showError(e.response?.data?.error || 'Failed to create a pairing code'); }
    finally { setPairing(false); }
  };
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

  const a = state?.account || {};
  const ag = state?.agent || null;
  const v = a.verification || {};
  // Reconciled health drives EVERY status card so they can't contradict each other.
  const health = state?.health || 'unknown';
  const healthTone = health === 'up' ? 'ok' : health === 'degraded' ? 'warn' : health === 'down' ? 'bad' : 'mut';
  const loggedOut = a.browserAuthCookies === 0;          // agent reports the RDP browser has no auth cookie
  const stTone = healthTone;                             // Session tone follows health, not the lagging raw status
  const agTone = !ag ? 'mut' : a.agentStale ? 'warn' : 'ok';
  const cdpUp = ag && ag.cdp === '200';
  const cdpTone = !ag ? 'mut' : cdpUp ? 'ok' : 'bad';
  // Cookie freshness and agent liveness are deliberately different readings: an agent can be alive
  // while cookies are behind, and cookies can be current while every agent is offline.
  const syncTone = loggedOut ? 'bad' : a.syncStale == null ? 'mut' : a.syncStale ? 'warn' : 'ok';
  const syncLabel = loggedOut ? 'logged out' : a.syncStale == null ? 'never' : a.syncStale ? 'behind' : 'fresh';
  // Multi-device view.
  const devices = state?.devices || [];
  const liveDevices = devices.filter((d) => !d.revoked);
  const activeSource = state?.activeSource || null;
  const frozen = state?.agentFrozenReport || null;   // last telemetry, known to be out of date
  const srcTone = !activeSource ? 'mut' : activeSource.online ? 'ok' : 'warn';
  // One honest session label: logged-out / working / unverified / the raw down-state.
  const sessionLabel = loggedOut ? 'logged out'
    : health === 'up' ? 'working'
    : health === 'down' ? (a.sessionStatus || 'down')
    : a.workingUnverified ? 'working · unverified'
    : (a.sessionStatus || a.status || '—');

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
      {conn === 'live' && !firstLoad && health !== 'up' && health !== 'unknown' && state?.statusReason && (
        <div className={`ds-card rounded-xl p-4 mb-5 border text-sm flex items-start gap-2 ${health === 'down' ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" /><span><strong>Needs attention:</strong> {state.statusReason}</span>
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
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
            <StatCard icon={Server} label="Active source" value={<Badge tone={srcTone}>{activeSource ? activeSource.name || activeSource.deviceId : 'none yet'}</Badge>} color="from-indigo-500 to-blue-600" />
            <StatCard icon={ShieldCheck} label="Session" value={<Badge tone={stTone}>{sessionLabel}</Badge>} color="from-blue-500 to-cyan-500" />
            <StatCard icon={Activity} label="Sync agent" value={<Badge tone={agTone}>{!ag ? 'no report' : a.agentStale ? 'stale' : 'live'}</Badge>} color="from-emerald-500 to-teal-500" />
            <StatCard icon={Chrome} label="Chrome / CDP" value={<Badge tone={cdpTone}>{!ag ? 'unknown' : cdpUp ? 'connected' : 'down'}</Badge>} color="from-violet-500 to-fuchsia-500" />
            <StatCard icon={Cookie} label="Cookie sync" value={<Badge tone={syncTone}>{syncLabel}</Badge>} color="from-amber-500 to-orange-500" />
          </div>

          {/* Paired devices — any of them may supply cookies; the newest VERIFIED bundle wins. */}
          <Panel icon={Server} title="Sync devices" tint="text-indigo-500" right={
            <div className="flex items-center gap-2">
              <input value={pairName} onChange={(e) => setPairName(e.target.value)} placeholder="Device name (e.g. LOCAL-PC)" maxLength={32}
                className="px-3 py-1.5 rounded-lg border border-slate-200 text-[13px] w-52 focus:outline-none focus:ring-2 focus:ring-indigo-200" />
              <button onClick={createPairCode} disabled={pairing}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-semibold text-white bg-gradient-to-r from-indigo-500 to-blue-600 disabled:opacity-50">
                {pairing ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />} Pair device
              </button>
            </div>
          }>
            {pairCode && (
              <div className="mb-3 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
                <p className="text-[13px] text-indigo-900 font-semibold mb-1">Pairing code for {pairCode.name}</p>
                <p className="font-mono text-2xl font-bold tracking-widest text-indigo-700 mb-2">{pairCode.code}</p>
                <p className="text-xs text-indigo-800/80">
                  Run the agent once on that machine with <code className="bg-white/70 px-1 py-0.5 rounded">WHV2_PAIR_CODE={pairCode.code}</code>.
                  Single use, expires {rel(pairCode.expiresAt).replace(' ago', '')} from now. It is shown only once — nothing can retrieve it again.
                </p>
                <button onClick={() => setPairCode(null)} className="mt-2 text-xs font-semibold text-indigo-700 hover:underline">Done</button>
              </div>
            )}
            {liveDevices.length === 0 ? (
              <p className="text-sm text-slate-400 py-3">No device paired yet. Pair the machine where you sign in to WriteHuman — you can pair several (local PC, RDP) and whichever has the freshest login takes over on its own.</p>
            ) : (
              <div className="space-y-2">
                {liveDevices.map((d) => (
                  <div key={d.deviceId} className="flex items-center justify-between gap-3 p-3 rounded-lg border border-slate-150 bg-slate-50/60">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-800 text-sm flex items-center gap-2 flex-wrap">
                        {d.name || d.deviceId}
                        {d.isActiveSource && <Badge tone="ok">active source</Badge>}
                        {d.online ? <Badge tone="ok">online</Badge> : <Badge tone="warn">offline · {rel(d.lastSeenAt)}</Badge>}
                        {d.lastResultCode && d.lastResultCode !== 'PROMOTED' && d.lastResultCode !== 'HEARTBEAT' && d.lastResultCode !== 'COOKIE_BUNDLE_UNCHANGED' && <Badge tone="warn">{d.lastResultCode}</Badge>}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5 truncate">
                        {d.hostname || '—'} · agent {d.agentVersion || '?'} · {d.promotionCount || 0} promotions · last sync {rel(d.lastSyncSuccessAt)}
                        {d.cdp ? ` · cdp ${d.cdp}` : ''}
                      </p>
                    </div>
                    <button onClick={() => revokeDevice(d)} className="px-3 py-1.5 rounded-lg text-[13px] font-semibold text-red-600 border border-red-200 hover:bg-red-50 flex-shrink-0">Revoke</button>
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
              <Row k="Health"><Badge tone={healthTone}>{health === 'up' ? 'healthy' : health}</Badge></Row>
              <Row k="Sign-in">{a.browserAuthCookies == null
                ? <Badge tone="mut">{a.telemetryFrozen ? 'unknown · no device reporting' : 'unknown'}</Badge>
                : loggedOut ? <Badge tone="bad">signed out</Badge> : <Badge tone="ok">signed in</Badge>}</Row>
              <Row k="Stored status">{a.status || '—'} / {a.sessionStatus || '—'}</Row>
              <Row k="Cookies stored">{a.cookieCount ?? '—'}</Row>
              <Row k="Bundle present">{a.hasBundle ? <Badge tone="ok">yes</Badge> : <Badge tone="warn">no</Badge>}</Row>
              <Row k="Access token valid">{a.accessTokenExpiresInSec == null ? '—' : a.accessTokenExpiresInSec <= 0 ? <Badge tone="warn">expired</Badge> : `~${dur(a.accessTokenExpiresInSec)}`}</Row>
            </Panel>

            <Panel icon={CheckCircle2} title="Verification" tint="text-emerald-500">
              <Row k="Result">{v.result ? <Badge tone={v.result === 'working' ? (a.workingUnverified ? 'warn' : 'ok') : v.result === 'session_expired' ? 'bad' : 'mut'}>{v.result === 'working' && a.workingUnverified ? 'working · unverified' : v.result}</Badge> : '—'}</Row>
              <Row k="Account (masked)">{v.maskedId || '—'}</Row>
              <Row k="HTTP">{v.httpStatus ?? '—'}</Row>
              <Row k="Last verification">{rel(a.lastVerifiedAt)}</Row>
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
              <p className="text-[12px] text-slate-400 mb-3">Diagnostics &amp; remote control. Account vault and client assignment are managed below.</p>
              <div className="flex flex-wrap gap-2">
                <button disabled={!!busy || conn !== 'live' || !a.id} onClick={() => act(() => writeHumanV2Admin.verify(a.id), 'Verify triggered')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-semibold text-white bg-gradient-to-r from-blue-600 to-cyan-500 disabled:opacity-50"><CheckCircle2 size={15} /> Verify now</button>
                <button disabled={!!busy || conn !== 'live'} onClick={() => act(() => writeHumanV2Admin.command('reverify'), 'Re-sync queued')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50"><RotateCw size={15} /> Re-sync</button>
                <button disabled={!!busy || conn !== 'live'} onClick={() => act(() => writeHumanV2Admin.command('relaunch-chrome'), 'Chrome relaunch queued')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50"><Play size={15} /> Relaunch Chrome</button>
              </div>
              {state?.pendingCommand && <p className="text-[12px] text-amber-600 mt-3 flex items-center gap-1"><Clock size={12} /> pending: {state.pendingCommand} (agent will pick it up next poll)</p>}
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
