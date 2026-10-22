'use strict';
/**
 * An HONEST in-memory stand-in for the ProxyAccount row store.
 *
 * WHAT IT IS, PRECISELY. This is MOCKED STORAGE. It is not the adapter, it is not SQL, and a pass
 * here is NOT evidence that MySQL/MariaDB accepts the statements the adapter emits. That is
 * `scripts/verifyguard-db-selftest.js`, run against a restricted scratch database on the same
 * engine/version as production (workflow `verifyguard-db-selftest.yml`).
 *
 * WHY IT EXISTS. The fixture it replaces was
 *
 *     { find: async () => ACCOUNTS }     // the SAME object every time
 *     save() { return Promise.resolve(this); }      // stores nothing
 *
 * which has no storage and no independent snapshots, so it cannot tell a guarded write from an
 * unguarded one, and describing a suite built on it as "only the provider was stubbed" was wrong.
 *
 * What this fixture does model, faithfully enough to be worth asserting against:
 *   - a ROW: one plain JSON document per id, held centrally;
 *   - INDEPENDENT SNAPSHOTS: every read returns a fresh deep copy with its own `__originalData`,
 *     so two "workers" cannot see each other's in-memory edits - the shape of the race;
 *   - save(): whole-document replace, exactly the destructive write under test;
 *   - patchGuarded(id, setMap, guardMap): sets ONLY the named dot-paths, and only while EVERY
 *     guard path still equals the stored value - including the adapter's two real quirks, that
 *     comparison is by string and that a null/undefined guard means "stored value is null or
 *     absent". Returns the affected-row count, as the adapter does.
 */
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setPath(o, p, v) {
  const parts = p.split('.');
  let cur = o;
  for (const k of parts.slice(0, -1)) {
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = v;
}

function createStore() {
  /** id -> stored row (plain JSON, as a database would hold it) */
  const rows = new Map();

  const model = {
    /** Mirrors adapter patchGuarded: partial JSON_SET under an ANDed guard. */
    async patchGuarded(id, setMap, guardMap) {
      const row = rows.get(String(id));
      if (!row) return 0;
      if (!setMap || !Object.keys(setMap).length) return 0;
      for (const [p, expected] of Object.entries(guardMap || {})) {
        const actual = getPath(row, p);
        if (expected === undefined || expected === null) {
          if (!(actual === undefined || actual === null)) return 0;
        } else if (actual === undefined || actual === null) {
          return 0;
        } else if (String(actual) !== String(expected)) {
          return 0;
        }
      }
      for (const [p, v] of Object.entries(setMap)) setPath(row, p, clone(v === undefined ? null : v));
      row.updatedAt = new Date().toISOString();
      return 1;
    },
    /** The raw stored row, for assertions. Never a snapshot. */
    _stored(id) { return rows.get(String(id)) || null; },
    _ids() { return [...rows.keys()]; },
  };

  function hydrate(row) {
    const doc = clone(row);
    Object.defineProperty(doc, '__model', { value: model, enumerable: false, writable: true });
    Object.defineProperty(doc, '__originalData', { value: clone(row), enumerable: false, writable: true });
    Object.defineProperty(doc, 'save', {
      enumerable: false,
      value: async function save() {
        // Whole-document replace - the write whose blast radius is the point of the guard.
        const out = {};
        for (const [k, v] of Object.entries(this)) out[k] = clone(v);
        out.updatedAt = new Date().toISOString();
        rows.set(String(this._id), out);
        this.__originalData = clone(out);
        return this;
      },
    });
    return doc;
  }

  return {
    model,
    /** Put a starting row in place (not a snapshot - the stored row itself). */
    seed(row) { rows.set(String(row._id), clone(row)); return this.load(row._id); },
    /** An INDEPENDENT read: a different worker's own snapshot. */
    load(id) { const r = rows.get(String(id)); return r ? hydrate(r) : null; },
    /** The stored row, for assertions about what actually landed. */
    stored(id) { return rows.get(String(id)) || null; },
    clear() { rows.clear(); },
    /** The shape `require.cache`-injected ProxyAccount needs. Each call re-hydrates. */
    asModelExports() {
      const matches = (d, criteria) => !criteria
        || Object.entries(criteria).every(([k, v]) => String(getPath(d, k)) === String(v));
      return {
        find: async (criteria) => [...rows.keys()]
          .map((id) => hydrate(rows.get(id)))
          .filter((d) => matches(d, criteria)),
        findOne: async (criteria) => {
          for (const id of rows.keys()) {
            const d = hydrate(rows.get(id));
            if (matches(d, criteria)) return d;
          }
          return null;
        },
        patchGuarded: model.patchGuarded,
      };
    },
  };
}

module.exports = { createStore };
