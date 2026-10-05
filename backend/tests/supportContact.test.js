/**
 * Official public support contact (WhatsApp + email) — backend single source + cross-surface guard.
 *
 *   utils/supportContact.js  admin row → env (SUPPORT_WHATSAPP_NUMBER / SUPPORT_EMAIL) → built-in
 *   GET  /api/crm/public/support-contact      (website, dashboard, extension expired page)
 *   GET/PUT /api/crm/admin/support-settings   (Admin → Support Contact)
 *
 * The SupportSettings model is replaced in require.cache by an in-memory stub, so no DB is
 * touched. The source scan at the end proves no active surface still carries the retired
 * number or a hard-coded wa.me support link.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..');
const ROOT = path.join(BACKEND, '..');
const MODEL_PATH = require.resolve('../models/SupportSettings');

// ── in-memory SupportSettings stub ───────────────────────────────────────────────
const store = { row: null, fail: false, hang: false, reads: 0 };
function makeRow(data) {
  return { ...data, async save() { store.row = makeRow({ ...this, whatsappNumber: this.whatsappNumber, supportEmail: this.supportEmail }); return this; } };
}
require.cache[MODEL_PATH] = {
  id: MODEL_PATH, filename: MODEL_PATH, loaded: true,
  exports: {
    async findOne() {
      store.reads++;
      if (store.hang) return new Promise(() => {});
      if (store.fail) throw new Error('db down');
      return store.row ? makeRow(store.row) : null;
    },
    async create(data) { store.row = makeRow(data); return store.row; },
  },
};

const sc = require('../utils/supportContact');

function reset({ env = {} } = {}) {
  store.row = null; store.fail = false; store.hang = false; store.reads = 0;
  delete process.env.SUPPORT_WHATSAPP_NUMBER; delete process.env.SUPPORT_EMAIL;
  Object.assign(process.env, env);
  sc._resetCacheForTests();
}

test('built-in default is +92 335 5500134 / admin@genzdigitalstore.com', async () => {
  reset();
  const c = await sc.getSupportContact();
  assert.deepStrictEqual(c, {
    whatsappNumber: '923355500134', whatsappDisplay: '+92 335 5500134',
    whatsappUrl: 'https://wa.me/923355500134', email: 'admin@genzdigitalstore.com', source: 'default',
  });
});

test('env overrides the built-in default; an invalid env value is ignored', async () => {
  reset({ env: { SUPPORT_WHATSAPP_NUMBER: '+92 300 1234567', SUPPORT_EMAIL: 'help@genzdigitalstore.com' } });
  let c = await sc.getSupportContact();
  assert.equal(c.whatsappNumber, '923001234567');
  assert.equal(c.email, 'help@genzdigitalstore.com');
  assert.equal(c.source, 'env');
  reset({ env: { SUPPORT_WHATSAPP_NUMBER: 'call me', SUPPORT_EMAIL: 'nope' } });
  c = await sc.getSupportContact();
  assert.equal(c.whatsappNumber, '923355500134');
  assert.equal(c.email, 'admin@genzdigitalstore.com');
});

test('admin update wins, normalises input, and is visible immediately to the saving worker', async () => {
  reset({ env: { SUPPORT_EMAIL: 'env@genzdigitalstore.com' } });
  const c = await sc.updateSupportContact({ whatsappNumber: '0335-5500134', supportEmail: ' Support@GenZDigitalStore.com ' }, 'admin1');
  assert.equal(c.whatsappNumber, '923355500134');
  assert.equal(c.whatsappDisplay, '+92 335 5500134');
  assert.equal(c.email, 'support@genzdigitalstore.com');
  assert.equal(c.source, 'admin');
  assert.equal(store.row.updatedBy, 'admin1');
  // Updating only one field keeps the other.
  const c2 = await sc.updateSupportContact({ whatsappNumber: '+44 7700 900123' });
  assert.equal(c2.whatsappNumber, '447700900123');
  assert.equal(c2.whatsappDisplay, '+447700900123');
  assert.equal(c2.email, 'support@genzdigitalstore.com');
});

test('empty values reset to the env/built-in fallback', async () => {
  reset();
  await sc.updateSupportContact({ whatsappNumber: '+92 300 1112233', supportEmail: 'x@y.com' });
  const c = await sc.updateSupportContact({ whatsappNumber: '', supportEmail: '' });
  assert.equal(c.whatsappNumber, '923355500134');
  assert.equal(c.email, 'admin@genzdigitalstore.com');
  assert.equal(c.source, 'default');
});

test('invalid admin input is rejected with 400 and nothing is written', async () => {
  reset();
  for (const patch of [{ whatsappNumber: '12' }, { whatsappNumber: 'wa.me/evil' }, { supportEmail: 'not-an-email' }, { supportEmail: 'a@b.com"><script>' }]) {
    await assert.rejects(sc.updateSupportContact(patch), (e) => e.status === 400, JSON.stringify(patch));
  }
  assert.equal(store.row, null);
});

test('DB failure or hang never throws — fallback, or last known-good admin value', async () => {
  reset();
  store.fail = true;
  assert.equal((await sc.getSupportContact()).whatsappNumber, '923355500134');

  reset();
  await sc.updateSupportContact({ whatsappNumber: '+92 300 1112233' });
  store.fail = true;
  assert.equal((await sc.getSupportContact({ fresh: true })).whatsappNumber, '923001112233');

  reset();
  store.hang = true;
  const t0 = Date.now();
  const c = await sc.getSupportContact();
  assert.equal(c.whatsappNumber, '923355500134');
  assert.ok(Date.now() - t0 < 3000, 'DB read must be time-boxed');
});

test('reads are cached per worker (public traffic does not hit the DB each time)', async () => {
  reset();
  await sc.getSupportContact(); await sc.getSupportContact(); await sc.getSupportContact();
  assert.equal(store.reads, 1);
  assert.equal(sc.CACHE_TTL_MS <= 60 * 1000, true, 'admin changes must reach every worker within a minute');
});

test('sync accessor never blocks: cached value, else env/built-in', async () => {
  reset();
  assert.equal(sc.getSupportContactSync().whatsappNumber, '923355500134');
  await sc.updateSupportContact({ whatsappNumber: '+92 300 1112233' });
  assert.equal(sc.getSupportContactSync().whatsappNumber, '923001112233');
});

test('email templates link to the live support contact', async () => {
  reset();
  await sc.updateSupportContact({ whatsappNumber: '+92 300 1112233' });
  const src = fs.readFileSync(path.join(BACKEND, 'utils/email.js'), 'utf8');
  assert.match(src, /require\('\.\/supportContact'\)/);
  assert.match(src, /<a href="\$\{supportWhatsApp\(\)\}"/);
  assert.match(src, /renewUrl \|\| supportWhatsApp\(\)/);
  assert.match(src, /ctaUrl \|\| supportWhatsApp\(\)/);
});

test('routes: public read + admin-protected update are mounted and deploy-listed', () => {
  const server = fs.readFileSync(path.join(BACKEND, 'server-crm.js'), 'utf8');
  assert.match(server, /app\.use\('\/api\/crm\/admin\/support-settings', adminSupportSettingsRoutes\)/);
  const pub = fs.readFileSync(path.join(BACKEND, 'routes/public.js'), 'utf8');
  assert.match(pub, /router\.get\('\/support-contact'/);
  const admin = fs.readFileSync(path.join(BACKEND, 'routes/admin/supportSettings.js'), 'utf8');
  assert.match(admin, /router\.use\(requireAuth\);\s*router\.use\(requireAdmin\);/);
  const adapter = fs.readFileSync(path.join(BACKEND, 'db/mysqlAdapter.js'), 'utf8');
  assert.match(adapter, /SupportSettings: 'support_settings'/);
  const deploy = fs.readFileSync(path.join(ROOT, 'deploy-hostinger.sh'), 'utf8');
  for (const f of ['utils/supportContact.js', 'models/SupportSettings.js', 'routes/admin/supportSettings.js']) {
    assert.ok(deploy.includes(`-T backend/${f}`), `${f} missing from deploy-hostinger.sh`);
  }
});

// ── cross-surface source guard ───────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (['node_modules', 'build', 'dist', '.git', 'tests', 'test', '__tests__'].includes(e.name)) continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(jsx?|mjs|html)$/.test(e.name)) out.push(rel);
  }
  return out;
}
const ACTIVE = [...walk('frontend/src'), ...walk('frontend/public'), ...walk('backend'), ...walk('chrome-extension')];
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('no active source retains the retired support number', () => {
  assert.ok(ACTIVE.length > 50, 'scan must actually cover the source tree');
  const hits = ACTIVE.filter((f) => /923027467462|0?302[ -]?746[ -]?7462/.test(read(f)));
  assert.deepStrictEqual(hits, []);
});

test('no hard-coded wa.me support link outside the single sources', () => {
  // Customer-facing CRM / admin "send to client" links are wa.me/${phone} (no literal digits).
  const allowed = new Set(['chrome-extension/expired.html'].map((p) => path.normalize(p)));
  const hits = ACTIVE.filter((f) => !allowed.has(path.normalize(f)) && /wa\.me\/\d/.test(read(f)));
  assert.deepStrictEqual(hits, []);
});

test('website/dashboard consumers read the live hook, not a static constant', () => {
  const consumers = [
    'frontend/src/components/WhatsAppButton.js', 'frontend/src/components/public/PublicNavbar.js',
    'frontend/src/components/public/PublicFooter.js', 'frontend/src/components/public/CTASection.js',
    'frontend/src/components/ClientLayoutEnhanced.js', 'frontend/src/components/DashboardOffers.js',
    'frontend/src/components/RenewPlanLink.js', 'frontend/src/pages/Home.js', 'frontend/src/pages/Pricing.js',
    'frontend/src/pages/Contact.js', 'frontend/src/pages/Join.js', 'frontend/src/pages/client/ClientLogin.js',
    'frontend/src/pages/client/ClientDashboardEnhanced.js', 'frontend/src/pages/client/ClientProfile.js',
    ...['AppDev', 'Branding', 'SEO', 'SocialMedia', 'WebDesign', 'Writing'].map((s) => `frontend/src/pages/public/Service${s}.js`),
  ];
  for (const f of consumers) assert.match(read(f), /useSupportContact\(\)/, f);
  // The public support email is rendered from the hook, not typed in.
  for (const f of ['frontend/src/components/public/PublicFooter.js', 'frontend/src/pages/Contact.js']) {
    assert.doesNotMatch(read(f), /admin@genzdigitalstore\.com/, f);
  }
  assert.doesNotMatch(read('frontend/src/components/public/PublicNavbar.js'), /export \{[^}]*WHATSAPP_URL/);
});
