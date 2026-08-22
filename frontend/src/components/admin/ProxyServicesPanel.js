import { useState, useEffect, useCallback, useRef } from 'react';
import { Moon, Sun, RefreshCw, Loader2, AlertTriangle } from 'lucide-react';
import { proxySleepAdmin } from '../../services/proxySleepService';
import { useToast } from '../Toast';

/**
 * Proxy Services — SLEEP / WAKE for the four managed proxy gateways.
 *
 * SLEEPING is not a cosmetic flag. The backend comments the `Passenger*` directives out of that
 * proxy's own docroot .htaccess, so the vhost answers a static 503 from the web server and
 * Passenger stops keeping the Node app resident — its workers exit and their RAM is returned.
 * Files, database, DNS and SSL are all preserved, and WAKE puts it straight back.
 *
 * The status shown here is read from the live .htaccess plus the real process count, never from a
 * stored flag, so it reflects what the server is actually doing.
 */
const STATUS_STYLES = {
  ACTIVE:        { cls: 'ds-badge ds-badge-success', label: 'ACTIVE' },
  SLEEPING:      { cls: 'ds-badge ds-badge-neutral', label: 'SLEEPING' },
  TRANSITIONING: { cls: 'ds-badge ds-badge-neutral', label: 'TRANSITIONING' },
  ERROR:         { cls: 'ds-badge ds-badge-danger',  label: 'ERROR' },
};

const fmtWhen = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch (_) { return '—'; }
};

export default function ProxyServicesPanel() {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const { showSuccess, showError } = useToast();
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await proxySleepAdmin.list();
      if (!alive.current) return;
      setServices((res && res.data && res.data.services) || []);
      setLoadError(false);
    } catch (_) {
      if (!alive.current) return;
      setLoadError(true);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = useCallback(async (svc, next) => {
    // Guard the double-click: the server also refuses concurrent transitions with a 409, but
    // there is no reason to send the second request at all.
    if (busyId) return;
    const verb = next === 'sleep' ? 'Sleep' : 'Wake';
    if (!window.confirm(
      `${verb} ${svc.name} (${svc.host})?\n\n` +
      (next === 'sleep'
        ? 'It will return a static 503 and its background workers will stop. Files, database, DNS and SSL are preserved.'
        : 'It will resume serving normally from its existing application.')
    )) return;

    setBusyId(svc.id);
    try {
      const res = next === 'sleep' ? await proxySleepAdmin.sleep(svc.id) : await proxySleepAdmin.wake(svc.id);
      if (!alive.current) return;
      const updated = res && res.data && res.data.service;
      if (updated) setServices((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      showSuccess(`${svc.name} is now ${updated ? updated.status : 'updated'}.`);
      // Workers take a moment to exit/spawn — re-read the real state shortly after.
      setTimeout(() => { if (alive.current) load(true); }, 2500);
    } catch (e) {
      if (!alive.current) return;
      const code = e && e.response && e.response.data && e.response.data.code;
      showError(
        code === 'transition_in_progress' ? 'That service is already changing state.'
        : code === 'unknown_service'      ? 'Unknown service.'
        : `Could not ${verb.toLowerCase()} ${svc.name}. Please try again.`
      );
      load(true);
    } finally {
      if (alive.current) setBusyId(null);
    }
  }, [busyId, load, showSuccess, showError]);

  return (
    <div className="ds-card p-5 md:p-6">
      <div className="flex items-center justify-between gap-3 mb-1">
        <h2 className="text-lg font-semibold">Proxy Services</h2>
        <button
          type="button"
          onClick={() => load()}
          className="inline-flex items-center gap-1.5 text-sm opacity-75 hover:opacity-100 transition"
          title="Refresh live status"
        >
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>
      <p className="text-sm opacity-70 mb-4">
        Put a proxy to sleep to free its server resources. The application, database, DNS and SSL
        are preserved — waking it restores normal service.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm opacity-70">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading services…
        </div>
      ) : loadError ? (
        <div className="flex items-center gap-2 py-6 text-sm">
          <AlertTriangle className="w-4 h-4" /> Could not load proxy service status.
        </div>
      ) : (
        <div className="space-y-3">
          {services.map((svc) => {
            const style = STATUS_STYLES[svc.status] || STATUS_STYLES.ERROR;
            const busy = busyId === svc.id || svc.status === 'TRANSITIONING';
            const asleep = svc.status === 'SLEEPING';
            const canAct = svc.status === 'ACTIVE' || svc.status === 'SLEEPING';
            return (
              <div
                key={svc.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-black/5 dark:border-white/10 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{svc.name}</span>
                    <span className={style.cls}>{busy ? 'TRANSITIONING' : style.label}</span>
                  </div>
                  <div className="text-xs opacity-60 mt-0.5 break-all">{svc.host}</div>
                  <div className="text-xs opacity-60 mt-0.5">
                    Last changed: {fmtWhen(svc.lastChanged)}
                    {typeof svc.workers === 'number' && (
                      <> · Runtime: {svc.workers > 0 ? `${svc.workers} worker${svc.workers === 1 ? '' : 's'}` : 'Stopped'}</>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  disabled={busy || !canAct}
                  onClick={() => act(svc, asleep ? 'wake' : 'sleep')}
                  className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium
                             border border-black/10 dark:border-white/15
                             hover:bg-black/5 dark:hover:bg-white/10 transition
                             disabled:opacity-50 disabled:cursor-not-allowed"
                  title={!canAct ? 'Needs manual attention on the server' : undefined}
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" />
                        : asleep ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                  {busy ? 'Working…' : asleep ? 'Wake' : 'Sleep'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
