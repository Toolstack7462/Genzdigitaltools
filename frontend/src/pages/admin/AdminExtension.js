import { useState, useEffect, useCallback, useRef } from 'react';
import AdminLayoutEnhanced from '../../components/AdminLayoutEnhanced';
import { Chrome, Upload, RefreshCw, Download, CheckCircle2, AlertTriangle, Clock, Bell, BellRing, Loader2 } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

// Admin Chrome-extension release management. Shows the latest version (read from
// the uploaded ZIP's manifest.json — never hardcoded), lets admin upload/replace
// the ZIP in the EXISTING download folder, set the minimum-required version /
// update_required policy, and see each client's installed version + last sync.
export default function AdminExtension() {
  const { showSuccess, showError } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [minVersion, setMinVersion] = useState('');
  const [updateRequired, setUpdateRequired] = useState(false);
  const [notifyBusy, setNotifyBusy] = useState(() => new Set()); // clientIds currently being notified
  const [notifyAllBusy, setNotifyAllBusy] = useState(false);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const { data: d } = await api.get('/admin/extension/release');
      setData(d);
      setMinVersion(d?.minimumRequiredVersion || '');
      setUpdateRequired(!!d?.updateRequired);
    } catch (err) {
      showError('Failed to load extension release info');
    } finally {
      setLoading(false);
    }
  }, [showError]);

  useEffect(() => { load(); }, [load]);

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) { showError('Please choose a .zip file'); return; }
    try {
      setUploading(true);
      const buf = await file.arrayBuffer();
      const { data: r } = await api.post('/admin/extension/upload', buf, {
        headers: { 'Content-Type': 'application/zip' },
      });
      showSuccess(`Uploaded extension v${r.version}`);
      await load();
    } catch (err) {
      const msg = err?.response?.data?.error || 'Upload failed';
      showError(msg);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const savePolicy = async () => {
    try {
      const { data: r } = await api.put('/admin/extension/policy', {
        minVersion: minVersion.trim() || null,
        updateRequired,
      });
      showSuccess('Update policy saved');
      setMinVersion(r.minVersion || '');
      setUpdateRequired(!!r.updateRequired);
      await load();
    } catch (err) {
      showError(err?.response?.data?.error || 'Failed to save policy');
    }
  };

  // Build a result toast from the notify endpoint's counts.
  const summarize = (r) => {
    const parts = [];
    if (r.notified) parts.push(`${r.notified} notified`);
    if (r.debounced) parts.push(`${r.debounced} recently notified (skipped)`);
    if (r.skippedUpToDate) parts.push(`${r.skippedUpToDate} already up to date`);
    if (r.skippedNoVersion) parts.push(`${r.skippedNoVersion} never synced`);
    return parts.length ? parts.join(' · ') : 'No outdated clients to notify';
  };

  // Notify one (or several) specific outdated clients.
  const notifyClients = async (ids) => {
    const clientIds = (ids || []).filter(Boolean);
    if (clientIds.length === 0) return;
    setNotifyBusy(prev => { const s = new Set(prev); clientIds.forEach(id => s.add(id)); return s; });
    try {
      const { data: r } = await api.post('/admin/extension/notify', { clientIds });
      if (r.notified) showSuccess(summarize(r));
      else showError(summarize(r));
      await load();
    } catch (err) {
      showError(err?.response?.data?.error || 'Failed to send notification');
    } finally {
      setNotifyBusy(prev => { const s = new Set(prev); clientIds.forEach(id => s.delete(id)); return s; });
    }
  };

  // Notify every outdated client in one shot (server filters + debounces).
  const notifyAll = async () => {
    setNotifyAllBusy(true);
    try {
      const { data: r } = await api.post('/admin/extension/notify', { all: true });
      if (r.notified) showSuccess(summarize(r));
      else showError(summarize(r));
      await load();
    } catch (err) {
      showError(err?.response?.data?.error || 'Failed to notify clients');
    } finally {
      setNotifyAllBusy(false);
    }
  };

  const latest = data?.latestVersion || null;
  const clients = data?.clients || [];
  const outdatedCount = clients.filter(c => c.isOutdated).length;

  return (
    <AdminLayoutEnhanced>
      <div className="max-w-5xl mx-auto space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-xl flex items-center justify-center text-white" style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }}>
              <Chrome size={20} />
            </span>
            <div>
              <h1 className="text-xl font-bold text-genz-navy">Chrome Extension</h1>
              <p className="text-[13px] text-genz-muted">Manage the published extension version and update policy.</p>
            </div>
          </div>
          <button onClick={load} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-semibold border border-genz-border text-genz-muted hover:text-genz-blue hover:border-genz-blue/40">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>

        {loading ? (
          <div className="text-genz-muted text-sm py-10 text-center">Loading…</div>
        ) : (
          <>
            {/* Release summary */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="ds-card p-4">
                <div className="text-[12px] text-genz-muted">Latest version</div>
                <div className="text-2xl font-bold text-genz-navy">{latest ? `v${latest}` : '—'}</div>
                <div className="text-[11px] text-genz-muted mt-1 break-all">{data?.filename || '—'}</div>
              </div>
              <div className="ds-card p-4">
                <div className="text-[12px] text-genz-muted">Minimum required</div>
                <div className="text-2xl font-bold text-genz-navy">{data?.minimumRequiredVersion ? `v${data.minimumRequiredVersion}` : '—'}</div>
                <div className="text-[11px] mt-1 font-semibold" style={{ color: data?.updateRequired ? '#dc2626' : '#16a34a' }}>
                  {data?.updateRequired ? 'Update required: ON' : 'Update required: OFF'}
                </div>
              </div>
              <div className="ds-card p-4">
                <div className="text-[12px] text-genz-muted">Uploaded</div>
                <div className="text-[15px] font-semibold text-genz-navy flex items-center gap-1.5">
                  <Clock size={14} /> {data?.uploadedAt ? new Date(data.uploadedAt).toLocaleString() : '—'}
                </div>
                <a href={`${data?.downloadPath || '/downloads/genz-digital-store-extension.zip'}${latest ? `?v=${latest}` : ''}`}
                   download={data?.filename || 'genz-digital-store-extension.zip'} target="_blank" rel="noopener noreferrer"
                   className="inline-flex items-center gap-1.5 mt-2 text-[12.5px] font-semibold text-genz-blue">
                  <Download size={14} /> Download latest
                </a>
              </div>
            </div>

            {/* Upload + policy */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="ds-card p-4">
                <h3 className="text-[14px] font-bold text-genz-navy mb-2">Upload latest ZIP</h3>
                <p className="text-[12px] text-genz-muted mb-3">The version is read from the ZIP’s <code>manifest.json</code> and the file replaces the existing download.</p>
                <input ref={fileRef} type="file" accept=".zip,application/zip" onChange={handleUpload} disabled={uploading}
                       className="block w-full text-[12.5px] text-genz-muted file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-[12.5px] file:font-semibold file:bg-genz-blue/10 file:text-genz-blue hover:file:bg-genz-blue/20" />
                {uploading && <div className="text-[12px] text-genz-muted mt-2 inline-flex items-center gap-1.5"><Upload size={13} className="animate-pulse" /> Uploading…</div>}
              </div>
              <div className="ds-card p-4">
                <h3 className="text-[14px] font-bold text-genz-navy mb-2">Update policy</h3>
                <label className="block text-[12px] text-genz-muted mb-1">Minimum required version</label>
                <input value={minVersion} onChange={e => setMinVersion(e.target.value)} placeholder="e.g. 3.9.3"
                       className="w-full px-3 py-2 rounded-lg border border-genz-border text-[13px] mb-3" />
                <label className="inline-flex items-center gap-2 text-[13px] text-genz-navy mb-3 cursor-pointer">
                  <input type="checkbox" checked={updateRequired} onChange={e => setUpdateRequired(e.target.checked)} />
                  Require update (block tools below latest)
                </label>
                <button onClick={savePolicy} className="w-full py-2 rounded-lg text-[13px] font-bold text-white" style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }}>
                  Save policy
                </button>
              </div>
            </div>

            {/* Per-client installed versions */}
            <div className="ds-card p-4">
              <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                <h3 className="text-[14px] font-bold text-genz-navy">Client installed versions ({clients.length})</h3>
                <button
                  onClick={notifyAll}
                  disabled={notifyAllBusy || outdatedCount === 0}
                  title={outdatedCount === 0 ? 'No outdated clients' : `Notify ${outdatedCount} outdated client${outdatedCount > 1 ? 's' : ''}`}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12.5px] font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }}>
                  {notifyAllBusy ? <Loader2 size={14} className="animate-spin" /> : <BellRing size={14} />}
                  Notify all outdated{outdatedCount > 0 ? ` (${outdatedCount})` : ''}
                </button>
              </div>
              {clients.length === 0 ? (
                <div className="text-[13px] text-genz-muted">No client has synced the extension yet.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="text-left text-genz-muted border-b border-genz-border">
                        <th className="py-2 pr-3">Client</th>
                        <th className="py-2 pr-3">Installed</th>
                        <th className="py-2 pr-3">Latest</th>
                        <th className="py-2 pr-3">Status</th>
                        <th className="py-2 pr-3">Last sync</th>
                        <th className="py-2 pr-3">Update notice</th>
                      </tr>
                    </thead>
                    <tbody>
                      {clients.map(c => (
                        <tr key={c.clientId} className="border-b border-genz-border/50">
                          <td className="py-2 pr-3">
                            <div className="font-semibold text-genz-navy">{c.name || c.email || c.clientId}</div>
                            {c.email && c.name && <div className="text-[11px] text-genz-muted">{c.email}</div>}
                          </td>
                          <td className="py-2 pr-3">{c.installedVersion ? `v${c.installedVersion}` : '—'}</td>
                          <td className="py-2 pr-3">{latest ? `v${latest}` : '—'}</td>
                          <td className="py-2 pr-3">
                            {c.updateRequired ? (
                              <span className="inline-flex items-center gap-1 text-red-600 font-semibold"><AlertTriangle size={12} /> Update required</span>
                            ) : c.isOutdated ? (
                              <span className="inline-flex items-center gap-1 text-amber-600 font-semibold"><AlertTriangle size={12} /> Outdated</span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-green-600 font-semibold"><CheckCircle2 size={12} /> Up to date</span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-genz-muted">{c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleString() : '—'}</td>
                          <td className="py-2 pr-3">
                            {!c.isOutdated ? (
                              <span className="text-genz-muted">—</span>
                            ) : (
                              <div className="flex flex-col gap-1">
                                <button
                                  onClick={() => notifyClients([c.clientId])}
                                  disabled={notifyBusy.has(c.clientId)}
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold border border-genz-blue/40 text-genz-blue hover:bg-genz-blue/10 disabled:opacity-50 disabled:cursor-not-allowed w-fit">
                                  {notifyBusy.has(c.clientId)
                                    ? <Loader2 size={12} className="animate-spin" />
                                    : (c.notified ? <BellRing size={12} /> : <Bell size={12} />)}
                                  {c.notified ? 'Notify again' : 'Notify update'}
                                </button>
                                {c.notified && c.notifiedAt && (
                                  <span className="text-[11px] text-green-600 inline-flex items-center gap-1">
                                    <CheckCircle2 size={11} /> Sent {new Date(c.notifiedAt).toLocaleString()}
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </AdminLayoutEnhanced>
  );
}
