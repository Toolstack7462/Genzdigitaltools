/* =====================================================================
   Showcase Mockups — high-fidelity SaaS-style UI previews
   All mockups respect the navy/teal/white brand palette.
   Each mockup is given an `accent` prop and renders inside the card preview area.
   ===================================================================== */
import {
  Cpu, Search, BarChart2, Users, PenTool, Globe, Sparkles, Settings, Shield,
  Chrome, MessageCircle, CheckCircle, Zap, Image, Palette, FileText,
  LayoutDashboard, TrendingUp, Lock, Send, Calendar, Star, Activity,
} from 'lucide-react';

/* ───────── shared chrome frame helpers ───────── */
const Browser = ({ url = 'app.genzdigitalstore.com', accent = '#06B6D4', children }) => (
  <div className="relative w-full h-full rounded-xl overflow-hidden bg-white"
    style={{ boxShadow: `0 18px 40px -18px rgba(7,27,51,0.35), 0 1px 0 rgba(255,255,255,0.85) inset, 0 0 0 1px rgba(13,42,71,0.08)` }}>
    <div className="flex items-center gap-1.5 px-3 py-2 border-b" style={{ borderColor: 'rgba(13,42,71,0.07)', background: 'linear-gradient(180deg,#f7fbfd,#eef5fa)' }}>
      <span className="w-2 h-2 rounded-full bg-red-400" />
      <span className="w-2 h-2 rounded-full bg-amber-400" />
      <span className="w-2 h-2 rounded-full bg-emerald-400" />
      <span className="ml-2 flex-1 h-4 rounded-full px-2.5 flex items-center text-[9px] font-semibold text-genz-muted"
        style={{ background: 'rgba(13,42,71,0.04)' }}>
        <span className="w-2 h-2 mr-1.5 rounded-full" style={{ background: accent }} />
        {url}
      </span>
    </div>
    <div className="relative" style={{ height: 'calc(100% - 28px)' }}>{children}</div>
  </div>
);

const Phone = ({ accent = '#06B6D4', children }) => (
  <div className="relative w-[112px] h-[200px] rounded-[22px] mx-auto"
    style={{ background: '#071B33', boxShadow: '0 20px 40px -16px rgba(7,27,51,0.5), 0 0 0 2px rgba(255,255,255,0.06) inset' }}>
    <span className="absolute top-1.5 left-1/2 -translate-x-1/2 w-10 h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.25)' }} />
    <div className="absolute inset-1.5 top-3 rounded-[18px] overflow-hidden bg-white">
      {children}
    </div>
  </div>
);

/* ─────────────────────────────────────────────────────────────────
   1) Premium Client Dashboard UI
   ───────────────────────────────────────────────────────────────── */
export const DashboardMock = ({ accent = '#06B6D4' }) => (
  <div className="w-full h-full p-3.5">
    <Browser url="dashboard.genzdigitalstore.com" accent={accent}>
      <div className="flex h-full">
        {/* sidebar */}
        <div className="w-[28%] p-2.5 flex flex-col gap-1.5" style={{ background: 'linear-gradient(180deg,#071B33,#0B2747)' }}>
          <div className="flex items-center gap-1.5 mb-2">
            <span className="w-4 h-4 rounded-md" style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }} />
            <span className="h-1.5 w-12 rounded-full bg-white/30" />
          </div>
          {[LayoutDashboard, Cpu, BarChart2, Settings].map((Icon, i) => (
            <div key={i} className="flex items-center gap-1.5 px-1.5 py-1 rounded-md"
              style={i === 0 ? { background: 'rgba(6,182,212,0.18)' } : {}}>
              <Icon size={9} style={{ color: i === 0 ? accent : 'rgba(255,255,255,0.55)' }} />
              <span className="h-1 w-8 rounded-full" style={{ background: i === 0 ? accent : 'rgba(255,255,255,0.18)' }} />
            </div>
          ))}
        </div>
        {/* main */}
        <div className="flex-1 p-2.5 space-y-2 overflow-hidden" style={{ background: '#f6f9fc' }}>
          {/* top KPI row */}
          <div className="grid grid-cols-3 gap-1.5">
            {[['Tools', '24'], ['Active', '18'], ['Reports', '6']].map(([l, n], i) => (
              <div key={l} className="rounded-md p-1.5 bg-white" style={{ boxShadow: '0 4px 10px -6px rgba(7,27,51,0.18), 0 0 0 1px rgba(13,42,71,0.06)' }}>
                <div className="text-[7px] font-semibold text-genz-muted leading-none">{l}</div>
                <div className="text-[10px] font-extrabold leading-none mt-1" style={{ color: i === 0 ? accent : '#071B33' }}>{n}</div>
              </div>
            ))}
          </div>
          {/* chart */}
          <div className="rounded-md p-2 bg-white relative" style={{ boxShadow: '0 4px 10px -6px rgba(7,27,51,0.18), 0 0 0 1px rgba(13,42,71,0.06)', height: 60 }}>
            <div className="flex items-end gap-1 h-full pt-2">
              {[40, 60, 35, 75, 50, 85, 65, 95, 70, 90].map((h, i) => (
                <span key={i} className="flex-1 rounded-sm"
                  style={{ height: `${h}%`, background: `linear-gradient(180deg,${accent},#2563EB)`, opacity: 0.4 + (h / 200) }} />
              ))}
            </div>
            <span className="absolute top-1.5 left-2 text-[7px] font-bold text-genz-navy/80">Tool usage</span>
          </div>
          {/* row of tool tiles */}
          <div className="grid grid-cols-2 gap-1.5">
            {[Cpu, PenTool, Search, Palette].map((Icon, i) => (
              <div key={i} className="rounded-md p-1.5 bg-white flex items-center gap-1.5"
                style={{ boxShadow: '0 4px 10px -6px rgba(7,27,51,0.18), 0 0 0 1px rgba(13,42,71,0.06)' }}>
                <span className="w-4 h-4 rounded flex items-center justify-center" style={{ background: `${accent}22`, color: accent }}>
                  <Icon size={8} />
                </span>
                <span className="flex-1 h-1.5 rounded-full bg-genz-navy/10" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Browser>
  </div>
);

/* ─────────────────────────────────────────────────────────────────
   2) Digital Tools SaaS Landing Page
   ───────────────────────────────────────────────────────────────── */
export const SaaSLandingMock = ({ accent = '#2563EB' }) => (
  <div className="w-full h-full p-3.5">
    <Browser url="genzdigitalstore.com" accent={accent}>
      <div className="relative h-full p-3" style={{ background: 'linear-gradient(180deg,#ffffff,#f3f8fc)' }}>
        {/* nav row */}
        <div className="flex items-center justify-between mb-2.5">
          <span className="w-10 h-2 rounded-full" style={{ background: 'linear-gradient(90deg,#2563EB,#06B6D4)' }} />
          <div className="flex items-center gap-1.5">
            {[0, 1, 2].map((i) => <span key={i} className="w-4 h-1 rounded-full bg-genz-navy/15" />)}
            <span className="w-8 h-3 rounded-md" style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }} />
          </div>
        </div>
        {/* eyebrow */}
        <div className="inline-block px-1.5 py-0.5 rounded-full mb-1.5 text-[6px] font-bold uppercase tracking-wider"
          style={{ background: 'rgba(6,182,212,0.12)', color: '#0891B2', border: '0.5px solid rgba(6,182,212,0.25)' }}>
          • Premium SaaS
        </div>
        {/* headline */}
        <div className="space-y-1 mb-2">
          <div className="h-2 w-[80%] rounded bg-genz-navy/85" />
          <div className="h-2 w-[55%] rounded" style={{ background: 'linear-gradient(90deg,#2563EB,#06B6D4,#14B8A6)' }} />
        </div>
        <div className="h-1 w-[70%] rounded-full bg-genz-navy/15 mb-2.5" />
        {/* CTA buttons */}
        <div className="flex gap-1.5 mb-2.5">
          <span className="h-3.5 w-12 rounded-md" style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }} />
          <span className="h-3.5 w-10 rounded-md border border-genz-navy/20 bg-white" />
        </div>
        {/* feature cards */}
        <div className="grid grid-cols-3 gap-1.5">
          {[Cpu, Sparkles, TrendingUp].map((Icon, i) => (
            <div key={i} className="rounded-md p-1.5 bg-white" style={{ boxShadow: '0 4px 10px -6px rgba(7,27,51,0.15), 0 0 0 1px rgba(13,42,71,0.05)' }}>
              <span className="w-3.5 h-3.5 rounded flex items-center justify-center mb-1"
                style={{ background: `${accent}22`, color: accent }}>
                <Icon size={8} />
              </span>
              <span className="h-1 w-full rounded-full bg-genz-navy/15 block" />
              <span className="h-0.5 w-2/3 rounded-full bg-genz-navy/10 block mt-0.5" />
            </div>
          ))}
        </div>
        {/* glow blob */}
        <span className="absolute -bottom-6 -right-6 w-16 h-16 rounded-full" style={{ background: `radial-gradient(circle,${accent}33,transparent 65%)`, filter: 'blur(8px)' }} />
      </div>
    </Browser>
  </div>
);

/* ─────────────────────────────────────────────────────────────────
   3) AI Tools Access Platform — Tools grid marketplace
   ───────────────────────────────────────────────────────────────── */
export const ToolsPlatformMock = ({ accent = '#14B8A6' }) => (
  <div className="w-full h-full p-3.5">
    <Browser url="app.genzdigitalstore.com/tools" accent={accent}>
      <div className="h-full p-2.5" style={{ background: 'linear-gradient(180deg,#0a2440,#071b33)' }}>
        {/* header */}
        <div className="flex items-center justify-between mb-2">
          <div>
            <span className="text-[7px] font-bold text-white/95 leading-none block">Tools Marketplace</span>
            <span className="text-[6px] text-white/50 leading-none block mt-0.5">90+ premium tools</span>
          </div>
          <span className="h-3 w-12 rounded-md" style={{ background: 'rgba(6,182,212,0.18)', border: '0.5px solid rgba(6,182,212,0.32)' }} />
        </div>
        {/* tools grid */}
        <div className="grid grid-cols-4 gap-1.5">
          {[
            { I: Cpu,        c: '#67E8F9' },
            { I: PenTool,    c: '#FCD34D' },
            { I: Search,     c: '#86EFAC' },
            { I: Palette,    c: '#7DD3FC' },
            { I: BarChart2,  c: '#93C5FD' },
            { I: Sparkles,   c: '#C4B5FD' },
            { I: TrendingUp, c: '#67E8F9' },
            { I: Zap,        c: '#FCD34D' },
          ].map(({ I, c }, i) => (
            <div key={i} className="aspect-square rounded-md flex flex-col items-center justify-center gap-0.5"
              style={{ background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.12)', backdropFilter: 'blur(4px)' }}>
              <span className="w-4 h-4 rounded flex items-center justify-center" style={{ background: `${c}26`, color: c, border: `0.5px solid ${c}40` }}>
                <I size={9} />
              </span>
              <span className="h-0.5 w-5 rounded-full bg-white/20" />
            </div>
          ))}
        </div>
        {/* floating connect chip */}
        <div className="absolute bottom-3 right-3 flex items-center gap-1 px-1.5 py-0.5 rounded-full"
          style={{ background: 'rgba(16,185,129,0.15)', border: '0.5px solid rgba(16,185,129,0.4)' }}>
          <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-[6px] font-bold text-emerald-300">Tools live</span>
        </div>
      </div>
    </Browser>
  </div>
);

/* ─────────────────────────────────────────────────────────────────
   4) Social Media Brand Kit — Instagram-style grid
   ───────────────────────────────────────────────────────────────── */
export const BrandKitMock = ({ accent = '#0891B2' }) => (
  <div className="w-full h-full p-4 flex items-center justify-center gap-3">
    {/* phone with feed */}
    <Phone accent={accent}>
      <div className="bg-white h-full">
        {/* profile row */}
        <div className="flex items-center gap-1 p-1 border-b border-genz-navy/10">
          <span className="w-4 h-4 rounded-full" style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }} />
          <div className="flex-1">
            <span className="block h-0.5 w-8 rounded-full bg-genz-navy/30" />
            <span className="block h-0.5 w-6 rounded-full bg-genz-navy/15 mt-0.5" />
          </div>
        </div>
        {/* feed grid */}
        <div className="grid grid-cols-3 gap-0.5 p-0.5">
          {[
            'linear-gradient(135deg,#2563EB,#06B6D4)',
            'linear-gradient(135deg,#14B8A6,#06B6D4)',
            'linear-gradient(135deg,#071B33,#2563EB)',
            'linear-gradient(135deg,#06B6D4,#0E7C95)',
            'linear-gradient(135deg,#0B2747,#06B6D4)',
            'linear-gradient(135deg,#14B8A6,#0EA5B5)',
            'linear-gradient(135deg,#2563EB,#0891B2)',
            'linear-gradient(135deg,#06B6D4,#14B8A6)',
            'linear-gradient(135deg,#0E7C95,#071B33)',
          ].map((g, i) => (
            <div key={i} className="aspect-square rounded" style={{ background: g }}>
              {i === 4 && <div className="w-full h-full flex items-center justify-center"><Star size={6} color="#fff" /></div>}
            </div>
          ))}
        </div>
      </div>
    </Phone>
    {/* swatches column */}
    <div className="space-y-1.5">
      <div className="text-[7px] font-bold text-genz-navy/85 mb-0.5">Brand kit</div>
      {[
        { c: '#2563EB', l: 'Royal' },
        { c: '#06B6D4', l: 'Cyan' },
        { c: '#14B8A6', l: 'Teal' },
        { c: '#071B33', l: 'Navy' },
      ].map(({ c, l }) => (
        <div key={l} className="flex items-center gap-1.5">
          <span className="w-4 h-4 rounded-md shadow-sm" style={{ background: c, boxShadow: `0 4px 10px -4px ${c}66` }} />
          <div>
            <span className="block text-[6.5px] font-bold text-genz-navy leading-none">{l}</span>
            <span className="block text-[5.5px] text-genz-muted leading-none mt-0.5 font-mono">{c}</span>
          </div>
        </div>
      ))}
      <div className="pt-1 mt-1 border-t border-genz-navy/10">
        <span className="text-[6px] text-genz-muted">Aa · Aa</span>
      </div>
    </div>
  </div>
);

/* ─────────────────────────────────────────────────────────────────
   5) Chrome Extension Workflow — extension popup + browser
   ───────────────────────────────────────────────────────────────── */
export const ExtensionMock = ({ accent = '#06B6D4' }) => (
  <div className="w-full h-full p-3.5 relative">
    <Browser url="open.tool/secure-bridge" accent={accent}>
      <div className="h-full relative p-3" style={{ background: 'linear-gradient(180deg,#f6f9fc,#eaf3f9)' }}>
        {/* fake site behind */}
        <div className="h-2 w-1/3 rounded bg-genz-navy/20 mb-2" />
        <div className="grid grid-cols-3 gap-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 rounded bg-white" style={{ boxShadow: '0 0 0 1px rgba(13,42,71,0.06)' }} />
          ))}
        </div>
      </div>
    </Browser>

    {/* extension popup floating */}
    <div className="absolute top-7 right-5 w-[58%] rounded-xl overflow-hidden"
      style={{
        background: 'linear-gradient(165deg,#071B33,#0B2747)',
        boxShadow: '0 24px 50px -16px rgba(7,27,51,0.55), 0 0 0 1px rgba(6,182,212,0.25), 0 0 30px -8px rgba(6,182,212,0.4)',
      }}>
      <div className="px-2.5 py-2 border-b border-white/8 flex items-center gap-1.5">
        <span className="w-3.5 h-3.5 rounded-md flex items-center justify-center" style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }}>
          <Chrome size={8} color="#fff" />
        </span>
        <span className="text-[7.5px] font-bold text-white">Gen Z Tools</span>
        <span className="ml-auto inline-flex items-center gap-1 px-1 py-0.5 rounded-full text-[5.5px] font-bold"
          style={{ background: 'rgba(16,185,129,0.18)', color: '#86EFAC' }}>
          <span className="w-0.5 h-0.5 rounded-full bg-emerald-400 animate-pulse" /> Connected
        </span>
      </div>
      <div className="p-2.5 space-y-1.5">
        {[
          { I: Cpu,     l: 'ChatGPT Plus',     s: 'Ready' },
          { I: PenTool, l: 'Jasper AI',        s: 'Ready' },
          { I: Search,  l: 'SEMrush Pro',      s: 'Ready' },
        ].map(({ I, l, s }, i) => (
          <div key={i} className="flex items-center gap-1.5 p-1 rounded-md"
            style={{ background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.1)' }}>
            <span className="w-3.5 h-3.5 rounded flex items-center justify-center" style={{ background: `${accent}26`, color: accent }}>
              <I size={8} />
            </span>
            <div className="flex-1 min-w-0">
              <span className="block text-[7px] font-bold text-white leading-none">{l}</span>
              <span className="block text-[5.5px] text-white/55 leading-none mt-0.5">{s}</span>
            </div>
            <span className="text-[5.5px] font-bold px-1 py-0.5 rounded" style={{ color: accent, background: `${accent}1f` }}>Open</span>
          </div>
        ))}
      </div>
    </div>
  </div>
);

/* ─────────────────────────────────────────────────────────────────
   6) Pricing / Membership Page Design — 3 cards
   ───────────────────────────────────────────────────────────────── */
export const PricingMock = ({ accent = '#2563EB' }) => (
  <div className="w-full h-full p-3.5">
    <Browser url="genzdigitalstore.com/pricing" accent={accent}>
      <div className="h-full p-2.5" style={{ background: 'linear-gradient(180deg,#ffffff,#f3f8fc)' }}>
        <div className="text-center mb-2.5">
          <div className="inline-block px-1.5 py-0.5 rounded-full text-[6px] font-bold uppercase tracking-wider mb-1"
            style={{ background: 'rgba(6,182,212,0.12)', color: '#0891B2' }}>• Pricing</div>
          <div className="h-1.5 w-20 mx-auto rounded-full bg-genz-navy/80 mb-0.5" />
          <div className="h-1.5 w-14 mx-auto rounded-full" style={{ background: 'linear-gradient(90deg,#2563EB,#06B6D4,#14B8A6)' }} />
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {[
            { name: 'Starter', highlight: false },
            { name: 'Pro',     highlight: true  },
            { name: 'Business',highlight: false },
          ].map(({ name, highlight }) => (
            <div key={name} className="rounded-md p-1.5 bg-white relative"
              style={{
                boxShadow: highlight
                  ? '0 14px 26px -10px rgba(37,99,235,0.45), 0 0 0 1.5px rgba(37,99,235,0.45)'
                  : '0 4px 10px -6px rgba(7,27,51,0.18), 0 0 0 1px rgba(13,42,71,0.06)',
                transform: highlight ? 'translateY(-3px)' : 'none',
              }}>
              {highlight && (
                <span className="absolute -top-1 left-1/2 -translate-x-1/2 px-1 py-0.5 rounded-full text-[5px] font-bold text-white"
                  style={{ background: 'linear-gradient(90deg,#2563EB,#06B6D4)' }}>POP</span>
              )}
              <span className="block text-[6px] font-bold uppercase tracking-wider mt-0.5 mb-1" style={{ color: highlight ? '#2563EB' : '#5b6b7c' }}>{name}</span>
              <span className="block h-2 w-10 rounded-full bg-genz-navy/85 mb-1" />
              <div className="space-y-0.5 mb-1.5">
                {[0,1,2,3].map((i) => (
                  <div key={i} className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: highlight ? '#2563EB' : '#14B8A6' }} />
                    <span className="h-0.5 flex-1 rounded-full bg-genz-navy/15" />
                  </div>
                ))}
              </div>
              <span className="block h-3 w-full rounded"
                style={highlight
                  ? { background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }
                  : { border: '0.5px solid rgba(37,99,235,0.3)', background: 'rgba(37,99,235,0.05)' }} />
            </div>
          ))}
        </div>
      </div>
    </Browser>
  </div>
);

/* ─────────────────────────────────────────────────────────────────
   7) Admin Panel Concept — sidebar + data table + KPIs
   ───────────────────────────────────────────────────────────────── */
export const AdminPanelMock = ({ accent = '#14B8A6' }) => (
  <div className="w-full h-full p-3.5">
    <Browser url="admin.genzdigitalstore.com" accent={accent}>
      <div className="flex h-full">
        {/* sidebar */}
        <div className="w-[24%] p-2 flex flex-col gap-1.5" style={{ background: 'linear-gradient(180deg,#061528,#071b33)' }}>
          <div className="flex items-center gap-1.5 mb-1">
            <span className="w-3 h-3 rounded" style={{ background: 'linear-gradient(135deg,#06B6D4,#14B8A6)' }} />
            <span className="h-1 w-8 rounded-full bg-white/30" />
          </div>
          {[Users, Cpu, Activity, Shield, Settings].map((Icon, i) => (
            <div key={i} className="flex items-center gap-1 px-1 py-0.5 rounded"
              style={i === 1 ? { background: 'rgba(20,184,166,0.18)' } : {}}>
              <Icon size={7} style={{ color: i === 1 ? accent : 'rgba(255,255,255,0.55)' }} />
              <span className="h-0.5 w-5 rounded-full" style={{ background: i === 1 ? accent : 'rgba(255,255,255,0.18)' }} />
            </div>
          ))}
        </div>
        {/* main */}
        <div className="flex-1 p-2 space-y-1.5" style={{ background: '#f6f9fc' }}>
          {/* KPI row */}
          <div className="grid grid-cols-4 gap-1">
            {[['Clients', '142'], ['Tools', '90+'], ['Active', '88'], ['Alerts', '3']].map(([l, n], i) => (
              <div key={l} className="rounded p-1 bg-white" style={{ boxShadow: '0 2px 6px -4px rgba(7,27,51,0.18), 0 0 0 1px rgba(13,42,71,0.05)' }}>
                <span className="block text-[5.5px] font-semibold text-genz-muted leading-none">{l}</span>
                <span className="block text-[7px] font-extrabold leading-none mt-0.5" style={{ color: i === 3 ? '#ef4444' : '#071B33' }}>{n}</span>
              </div>
            ))}
          </div>
          {/* table */}
          <div className="rounded bg-white p-1.5" style={{ boxShadow: '0 2px 6px -4px rgba(7,27,51,0.18), 0 0 0 1px rgba(13,42,71,0.05)', height: 78 }}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[6px] font-bold text-genz-navy/85">Recent activity</span>
              <span className="text-[5px] text-genz-muted">View all</span>
            </div>
            {[0,1,2,3].map((i) => (
              <div key={i} className="flex items-center gap-1 py-0.5 border-t" style={{ borderColor: i ? 'rgba(13,42,71,0.06)' : 'transparent' }}>
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: i % 2 ? 'linear-gradient(135deg,#06B6D4,#14B8A6)' : 'linear-gradient(135deg,#2563EB,#06B6D4)' }} />
                <span className="h-0.5 w-12 rounded-full bg-genz-navy/15" />
                <span className="ml-auto text-[5px] font-bold px-1 rounded" style={{ color: '#10B981', background: 'rgba(16,185,129,0.12)' }}>OK</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Browser>
  </div>
);

/* ─────────────────────────────────────────────────────────────────
   8) WhatsApp Support / Client Portal Flow — chat bubbles + phone
   ───────────────────────────────────────────────────────────────── */
export const WhatsAppPortalMock = ({ accent = '#10B981' }) => (
  <div className="w-full h-full p-4 flex items-center justify-center gap-3">
    <Phone accent={accent}>
      <div className="h-full flex flex-col" style={{ background: 'linear-gradient(180deg,#ECE5DD,#DBD2C5)' }}>
        {/* header */}
        <div className="flex items-center gap-1 px-1.5 py-1" style={{ background: 'linear-gradient(135deg,#075E54,#128C7E)' }}>
          <span className="w-3 h-3 rounded-full" style={{ background: 'linear-gradient(135deg,#2563EB,#06B6D4)' }} />
          <div>
            <span className="block text-[5.5px] font-bold text-white leading-none">Gen Z Support</span>
            <span className="block text-[4.5px] text-white/75 leading-none mt-0.5">online</span>
          </div>
        </div>
        {/* bubbles */}
        <div className="flex-1 p-1.5 space-y-1 overflow-hidden">
          <div className="rounded-md rounded-tl-none px-1.5 py-1 bg-white max-w-[80%]" style={{ boxShadow: '0 1px 2px rgba(0,0,0,0.06)' }}>
            <span className="block text-[4.5px] font-semibold text-genz-navy">Hi, how do I access tools?</span>
          </div>
          <div className="ml-auto rounded-md rounded-tr-none px-1.5 py-1 max-w-[85%]" style={{ background: '#DCF8C6' }}>
            <span className="block text-[4.5px] font-semibold text-genz-navy">Just log in to your member dashboard.</span>
          </div>
          <div className="ml-auto rounded-md rounded-tr-none px-1.5 py-1 max-w-[60%]" style={{ background: '#DCF8C6' }}>
            <span className="block text-[4.5px] font-semibold text-genz-navy">Setup link sent ✓</span>
          </div>
        </div>
        {/* input */}
        <div className="px-1.5 py-1 flex items-center gap-1" style={{ background: '#F0F0F0' }}>
          <span className="flex-1 h-2 rounded-full bg-white" />
          <span className="w-3 h-3 rounded-full flex items-center justify-center" style={{ background: '#128C7E' }}>
            <Send size={5} color="#fff" />
          </span>
        </div>
      </div>
    </Phone>
    {/* side process cards */}
    <div className="space-y-1.5">
      <div className="text-[7px] font-bold text-genz-navy/85 mb-0.5">Portal flow</div>
      {[
        { I: MessageCircle, l: 'Client message',      c: '#10B981' },
        { I: LayoutDashboard, l: 'Portal sync',       c: '#06B6D4' },
        { I: Lock,          l: 'Secure access',       c: '#2563EB' },
        { I: CheckCircle,   l: 'Resolved',            c: '#14B8A6' },
      ].map(({ I, l, c }, i) => (
        <div key={l} className="flex items-center gap-1.5 px-1.5 py-1 rounded-md bg-white"
          style={{ boxShadow: '0 4px 10px -6px rgba(7,27,51,0.18), 0 0 0 1px rgba(13,42,71,0.06)' }}>
          <span className="w-3.5 h-3.5 rounded-md flex items-center justify-center" style={{ background: `${c}22`, color: c }}>
            <I size={8} />
          </span>
          <div>
            <span className="block text-[6px] font-bold text-genz-navy leading-none">{l}</span>
            <span className="block text-[5px] text-genz-muted leading-none mt-0.5">step {i + 1}</span>
          </div>
        </div>
      ))}
    </div>
  </div>
);
