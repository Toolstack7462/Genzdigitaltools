import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AdminLayoutEnhanced from '../../components/AdminLayoutEnhanced';
import {
  Package, Globe, Key, Settings, CheckCircle2, ArrowRight, ArrowLeft,
  TestTube2, Zap, Eye, EyeOff, ExternalLink, Shield, Info
} from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

const STEPS = [
  { id: 1, label: 'Basic Info',    icon: Package  },
  { id: 2, label: 'Credentials',  icon: Key      },
  { id: 3, label: 'Settings',     icon: Settings },
  { id: 4, label: 'Test & Save',  icon: TestTube2 },
];

const CRED_TYPES = [
  { value: 'form',            label: 'Form Login',        desc: 'Fill username/password form' },
  { value: 'cookies',         label: 'Cookie Injection',  desc: 'Inject pre-auth cookies'     },
  { value: 'sso',             label: 'SSO / OAuth',       desc: 'Google, Microsoft, etc.'     },
  { value: 'token',           label: 'API Token',         desc: 'Bearer token / header auth'  },
  { value: 'localStorage',    label: 'LocalStorage',      desc: 'Inject localStorage data'    },
  { value: 'none',            label: 'Direct Access',     desc: 'No auth required'            },
];

const CATEGORIES = ['AI', 'Academic', 'SEO', 'Productivity', 'Graphics & SEO', 'Text Humanizers', 'Career-Oriented', 'Miscellaneous', 'Other'];

const AdminToolWizard = () => {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [showPass, setShowPass] = useState(false);

  const [form, setForm] = useState({
    // Step 1
    name: '', description: '', targetUrl: '', loginUrl: '', category: 'AI',
    // Step 2
    credentialType: 'form',
    username: '', password: '',
    cookies: '', token: '', tokenHeader: 'Authorization', tokenPrefix: 'Bearer ',
    ssoUrl: '', ssoProvider: '',
    localStorage: '',
    // Step 3
    requirePermission: true, autoInject: true, reloadAfterLogin: true,
    successUrlIncludes: '', successElementExists: '',
    notes: '',
  });

  const update = (key, value) => setForm(prev => ({ ...prev, [key]: value }));

  const canNext = () => {
    if (step === 1) return form.name.trim() && form.targetUrl.trim();
    if (step === 2) {
      if (form.credentialType === 'form')  return form.username && form.password;
      if (form.credentialType === 'cookies') return form.cookies.trim();
      if (form.credentialType === 'token')  return form.token.trim();
      if (form.credentialType === 'sso')   return form.ssoUrl.trim();
      if (form.credentialType === 'localStorage') return form.localStorage.trim();
      if (form.credentialType === 'none')  return true;
    }
    if (step === 3) return true;
    return true;
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.post('/admin/tools/test', {
        targetUrl: form.targetUrl,
        loginUrl: form.loginUrl || form.targetUrl,
        credentialType: form.credentialType,
      });
      setTestResult({ ok: true, message: res.data.message || 'URL reachable' });
    } catch (err) {
      setTestResult({ ok: false, message: err.response?.data?.error || 'Could not reach URL' });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim(),
        targetUrl: form.targetUrl.trim(),
        loginUrl: form.loginUrl.trim() || form.targetUrl.trim(),
        category: form.category,
        credentialType: form.credentialType,
        credentials: {
          type: form.credentialType,
          selectors: {},
          successCheck: {
            urlIncludes: form.successUrlIncludes || undefined,
            elementExists: form.successElementExists || undefined,
          },
        },
        extensionSettings: {
          requirePermission: form.requirePermission,
          autoInject: form.autoInject,
          reloadAfterLogin: form.reloadAfterLogin,
          notes: form.notes,
        },
      };

      // Build credential payload per type
      if (form.credentialType === 'form') {
        payload.credentials.payload = { username: form.username, password: form.password };
      } else if (form.credentialType === 'cookies') {
        payload.cookiesEncrypted = form.cookies; // backend encrypts
      } else if (form.credentialType === 'token') {
        payload.tokenEncrypted = form.token;
        payload.tokenHeader = form.tokenHeader;
        payload.tokenPrefix = form.tokenPrefix;
      } else if (form.credentialType === 'sso') {
        payload.credentials.payload = { authStartUrl: form.ssoUrl, provider: form.ssoProvider };
      } else if (form.credentialType === 'localStorage') {
        payload.localStorageEncrypted = form.localStorage;
      }

      await api.post('/admin/tools', payload);
      showSuccess(`Tool "${form.name}" created successfully!`);
      navigate('/admin/tools');
    } catch (err) {
      showError(err.response?.data?.error || 'Failed to save tool');
    } finally {
      setSaving(false);
    }
  };

  const cardClass = 'bg-white/[0.04] border border-white/10 rounded-2xl p-6';
  const inputClass = 'w-full px-3 py-2.5 rounded-xl text-sm text-white placeholder-genz-muted focus:outline-none transition-all bg-white/[0.05] border border-white/10 focus:border-genz-teal';
  const labelClass = 'block text-xs font-medium text-genz-muted mb-1.5';

  return (
    <AdminLayoutEnhanced>
      <div className="max-w-3xl mx-auto">

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-black text-white mb-1">Tool Setup Wizard</h1>
          <p className="text-genz-muted text-sm">Configure a new tool step by step</p>
        </div>

        {/* Stepper */}
        <div className="flex items-center gap-2 mb-8">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            const active  = step === s.id;
            const done    = step > s.id;
            return (
              <div key={s.id} className="flex items-center gap-2 flex-1">
                <div className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
                  active ? 'text-genz-deep-navy' : done ? 'text-genz-teal' : 'text-genz-muted'
                }`}
                style={active ? { background: 'linear-gradient(135deg,#00AFC1,#008EA3)' } : {}}>
                  {done ? <CheckCircle2 size={14} /> : <Icon size={14} />}
                  <span className="hidden sm:inline">{s.label}</span>
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`flex-1 h-0.5 rounded-full ${done ? 'bg-genz-teal' : 'bg-white/10'}`} />
                )}
              </div>
            );
          })}
        </div>

        {/* Step 1 — Basic Info */}
        {step === 1 && (
          <div className={cardClass}>
            <h2 className="font-bold text-white mb-5">Basic Tool Information</h2>
            <div className="space-y-4">
              <div>
                <label className={labelClass}>Tool Name *</label>
                <input className={inputClass} placeholder="e.g. ChatGPT Premium" value={form.name}
                       onChange={e => update('name', e.target.value)} />
              </div>
              <div>
                <label className={labelClass}>Description</label>
                <textarea className={`${inputClass} resize-none`} rows={2}
                          placeholder="Short description for members"
                          value={form.description} onChange={e => update('description', e.target.value)} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>Target URL * <span className="text-genz-muted">(tool homepage)</span></label>
                  <input className={inputClass} placeholder="https://chat.openai.com" value={form.targetUrl}
                         onChange={e => update('targetUrl', e.target.value)} />
                </div>
                <div>
                  <label className={labelClass}>Login URL <span className="text-genz-muted">(if different)</span></label>
                  <input className={inputClass} placeholder="https://chat.openai.com/auth/login" value={form.loginUrl}
                         onChange={e => update('loginUrl', e.target.value)} />
                </div>
              </div>
              <div>
                <label className={labelClass}>Category</label>
                <select className={inputClass} value={form.category} onChange={e => update('category', e.target.value)}>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
          </div>
        )}

        {/* Step 2 — Credentials */}
        {step === 2 && (
          <div className={cardClass}>
            <h2 className="font-bold text-white mb-2">Credential Configuration</h2>
            <p className="text-xs text-genz-muted mb-5">All credentials are AES-256-GCM encrypted at rest.</p>

            {/* Cred type picker */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
              {CRED_TYPES.map(ct => (
                <button key={ct.value} onClick={() => update('credentialType', ct.value)}
                        className={`p-3 rounded-xl border text-left transition-all text-sm ${
                          form.credentialType === ct.value
                            ? 'border-genz-teal text-white'
                            : 'border-white/10 text-genz-muted hover:border-white/20'
                        }`}
                        style={form.credentialType === ct.value ? { background: 'rgba(0,175,193,0.1)' } : {}}>
                  <p className="font-semibold">{ct.label}</p>
                  <p className="text-xs opacity-70 mt-0.5">{ct.desc}</p>
                </button>
              ))}
            </div>

            {/* Form login */}
            {form.credentialType === 'form' && (
              <div className="space-y-3">
                <div>
                  <label className={labelClass}>Username / Email *</label>
                  <input className={inputClass} placeholder="member@example.com" value={form.username}
                         onChange={e => update('username', e.target.value)} />
                </div>
                <div>
                  <label className={labelClass}>Password *</label>
                  <div className="relative">
                    <input className={`${inputClass} pr-10`} type={showPass ? 'text' : 'password'}
                           placeholder="••••••••" value={form.password}
                           onChange={e => update('password', e.target.value)} />
                    <button className="absolute right-3 top-1/2 -translate-y-1/2 text-genz-muted hover:text-white"
                            onClick={() => setShowPass(!showPass)}>
                      {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Cookie injection */}
            {form.credentialType === 'cookies' && (
              <div>
                <label className={labelClass}>Cookies JSON Array *</label>
                <textarea className={`${inputClass} resize-none font-mono text-xs`} rows={6}
                          placeholder={'[\n  {"name":"session","value":"abc123","domain":".example.com"}\n]'}
                          value={form.cookies} onChange={e => update('cookies', e.target.value)} />
              </div>
            )}

            {/* Token */}
            {form.credentialType === 'token' && (
              <div className="space-y-3">
                <div>
                  <label className={labelClass}>Token Value *</label>
                  <input className={inputClass} type={showPass ? 'text' : 'password'}
                         placeholder="eyJhbGci..." value={form.token}
                         onChange={e => update('token', e.target.value)} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelClass}>Header Name</label>
                    <input className={inputClass} value={form.tokenHeader}
                           onChange={e => update('tokenHeader', e.target.value)} />
                  </div>
                  <div>
                    <label className={labelClass}>Prefix</label>
                    <input className={inputClass} value={form.tokenPrefix}
                           onChange={e => update('tokenPrefix', e.target.value)} />
                  </div>
                </div>
              </div>
            )}

            {/* SSO */}
            {form.credentialType === 'sso' && (
              <div className="space-y-3">
                <div className="p-3 rounded-xl border border-yellow-500/30 bg-yellow-500/10 flex gap-2">
                  <Info size={14} className="text-yellow-400 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-yellow-300">SSO flows may require manual completion if the provider triggers MFA or CAPTCHA. The extension will pause and notify the user.</p>
                </div>
                <div>
                  <label className={labelClass}>SSO Auth Start URL *</label>
                  <input className={inputClass} placeholder="https://example.com/auth/google" value={form.ssoUrl}
                         onChange={e => update('ssoUrl', e.target.value)} />
                </div>
                <div>
                  <label className={labelClass}>Provider (optional)</label>
                  <input className={inputClass} placeholder="google / microsoft / github" value={form.ssoProvider}
                         onChange={e => update('ssoProvider', e.target.value)} />
                </div>
              </div>
            )}

            {/* localStorage */}
            {form.credentialType === 'localStorage' && (
              <div>
                <label className={labelClass}>LocalStorage JSON Object *</label>
                <textarea className={`${inputClass} resize-none font-mono text-xs`} rows={5}
                          placeholder={'{"auth_token":"abc123","user_id":"456"}'}
                          value={form.localStorage} onChange={e => update('localStorage', e.target.value)} />
              </div>
            )}

            {/* Direct access */}
            {form.credentialType === 'none' && (
              <div className="p-4 rounded-xl border border-genz-teal/20 bg-genz-teal/5 text-sm text-genz-muted">
                This tool requires no authentication. Members will be redirected directly to the target URL.
              </div>
            )}
          </div>
        )}

        {/* Step 3 — Settings */}
        {step === 3 && (
          <div className={cardClass}>
            <h2 className="font-bold text-white mb-5">Extension & Success Settings</h2>
            <div className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[
                  { key: 'requirePermission', label: 'Require host permission' },
                  { key: 'autoInject',        label: 'Auto inject on load'     },
                  { key: 'reloadAfterLogin',  label: 'Reload after login'      },
                ].map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-3 p-3 rounded-xl border border-white/10 cursor-pointer hover:border-genz-teal/30 transition-all">
                    <input type="checkbox" checked={form[key]}
                           onChange={e => update(key, e.target.checked)}
                           className="w-4 h-4 accent-genz-teal" />
                    <span className="text-sm text-white/80">{label}</span>
                  </label>
                ))}
              </div>
              <div>
                <label className={labelClass}>Success Check — URL should include</label>
                <input className={inputClass} placeholder="/dashboard or /home" value={form.successUrlIncludes}
                       onChange={e => update('successUrlIncludes', e.target.value)} />
              </div>
              <div>
                <label className={labelClass}>Success Check — Element selector visible after login</label>
                <input className={inputClass} placeholder=".user-avatar or #main-content" value={form.successElementExists}
                       onChange={e => update('successElementExists', e.target.value)} />
              </div>
              <div>
                <label className={labelClass}>Admin Notes (not shown to members)</label>
                <textarea className={`${inputClass} resize-none`} rows={2} value={form.notes}
                          onChange={e => update('notes', e.target.value)}
                          placeholder="Any notes about this tool's access method" />
              </div>
            </div>
          </div>
        )}

        {/* Step 4 — Test & Save */}
        {step === 4 && (
          <div className={cardClass}>
            <h2 className="font-bold text-white mb-5">Review & Save</h2>

            {/* Summary */}
            <div className="space-y-2 mb-6 text-sm">
              {[
                ['Tool Name',   form.name],
                ['Category',    form.category],
                ['Target URL',  form.targetUrl],
                ['Auth Method', CRED_TYPES.find(c => c.value === form.credentialType)?.label],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center gap-3 p-3 rounded-lg bg-white/[0.03] border border-white/5">
                  <span className="text-genz-muted w-28 flex-shrink-0">{k}</span>
                  <span className="text-white font-medium truncate">{v}</span>
                </div>
              ))}
            </div>

            {/* Test button */}
            <div className="mb-6">
              <p className="text-xs text-genz-muted mb-3">
                Run a basic connectivity test to verify the tool URL is reachable.
              </p>
              <button onClick={runTest} disabled={testing}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold border border-genz-teal/40 text-genz-teal hover:bg-genz-teal/10 transition-all disabled:opacity-50">
                <TestTube2 size={15} />
                {testing ? 'Testing...' : 'Test Tool URL'}
              </button>
              {testResult && (
                <div className={`mt-3 flex items-center gap-2 p-3 rounded-xl text-sm ${
                  testResult.ok
                    ? 'bg-green-500/10 border border-green-500/30 text-green-400'
                    : 'bg-red-500/10 border border-red-500/30 text-red-400'
                }`}>
                  {testResult.ok ? <CheckCircle2 size={14} /> : <Shield size={14} />}
                  {testResult.message}
                </div>
              )}
            </div>

            <button onClick={handleSave} disabled={saving}
                    className="w-full py-3.5 rounded-xl font-bold text-genz-deep-navy flex items-center justify-center gap-2 transition-all hover:opacity-90 hover:scale-105 disabled:opacity-50 disabled:scale-100"
                    style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
              <Zap size={18} />
              {saving ? 'Saving...' : 'Save Tool'}
            </button>
          </div>
        )}

        {/* Navigation */}
        <div className="flex justify-between mt-6">
          <button onClick={() => step > 1 ? setStep(s => s - 1) : navigate('/admin/tools')}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm border border-white/10 text-genz-muted hover:border-white/30 hover:text-white transition-all">
            <ArrowLeft size={15} />
            {step === 1 ? 'Cancel' : 'Back'}
          </button>
          {step < 4 && (
            <button onClick={() => setStep(s => s + 1)} disabled={!canNext()}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-genz-deep-navy transition-all hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
              Continue <ArrowRight size={15} />
            </button>
          )}
        </div>
      </div>
    </AdminLayoutEnhanced>
  );
};

export default AdminToolWizard;
