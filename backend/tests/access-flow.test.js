'use strict';
/**
 * Regression test suite — Access Flow (P2 backlog item).
 *
 * Locks the behaviour of the single source of truth that decides whether a
 * client can access a tool RIGHT NOW:
 *
 *   - `ToolAssignment.effectiveEndBoundary(endDate)`  (pure)
 *   - `ToolAssignment.isAssignmentExpired(a, now?)`   (pure)
 *   - `ToolAssignment.findActiveForClientTool(...)`   (DB read, here mocked)
 *   - `getClientAccessibleTool(clientId, toolId)`     (orchestrator)
 *
 * These tests intentionally do NOT touch MySQL — `find()` is stubbed.
 * Run with:  cd /app/backend && yarn test
 */

const ToolAssignment = require('../models/ToolAssignment');
const {
  getClientAccessibleTool,
  listClientAccessibleTools,
} = require('../utils/getClientAccessibleTool');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAssignment({
  _id = 'a-' + Math.random().toString(36).slice(2, 8),
  clientId = 'client-1',
  toolId = 'tool-1',
  toolStatus = 'active',
  status = 'active',
  startDate = null,
  endDate = null,
}) {
  return {
    _id,
    clientId,
    status,
    startDate,
    endDate,
    // Populated tool — `findActiveForClientTool` checks `a.toolId._id` and
    // `a.toolId.status`.
    toolId: { _id: toolId, status: toolStatus },
  };
}

/** Stub `ToolAssignment.find(...).populate('toolId')` to return given rows. */
function mockFind(rows) {
  return jest.spyOn(ToolAssignment, 'find').mockImplementation(() => ({
    populate: () => Promise.resolve(rows),
  }));
}

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pure: effectiveEndBoundary
// ---------------------------------------------------------------------------

describe('ToolAssignment.effectiveEndBoundary', () => {
  test('returns null when endDate is missing', () => {
    expect(ToolAssignment.effectiveEndBoundary(null)).toBeNull();
    expect(ToolAssignment.effectiveEndBoundary(undefined)).toBeNull();
    expect(ToolAssignment.effectiveEndBoundary('')).toBeNull();
  });

  test('date-only string is treated as INCLUSIVE end-of-day 23:59:59.999 UTC', () => {
    const b = ToolAssignment.effectiveEndBoundary('2026-06-10');
    expect(b).toBeInstanceOf(Date);
    expect(b.toISOString()).toBe('2026-06-10T23:59:59.999Z');
  });

  test('"YYYY-MM-DD 00:00:00" midnight form is also end-of-day', () => {
    const b = ToolAssignment.effectiveEndBoundary('2026-06-10 00:00:00');
    expect(b.toISOString()).toBe('2026-06-10T23:59:59.999Z');
  });

  test('ISO timestamp with non-zero time is preserved as-is', () => {
    const iso = '2026-06-10T14:30:00.000Z';
    const b = ToolAssignment.effectiveEndBoundary(iso);
    expect(b.toISOString()).toBe(iso);
  });

  test('Date object at UTC midnight is bumped to end-of-day', () => {
    const dt = new Date('2026-06-10T00:00:00.000Z');
    const b = ToolAssignment.effectiveEndBoundary(dt);
    expect(b.toISOString()).toBe('2026-06-10T23:59:59.999Z');
  });

  test('invalid date returns null', () => {
    expect(ToolAssignment.effectiveEndBoundary('not-a-date')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pure: isAssignmentExpired
// ---------------------------------------------------------------------------

describe('ToolAssignment.isAssignmentExpired', () => {
  test('no endDate ⇒ never expired', () => {
    const a = makeAssignment({ endDate: null });
    expect(ToolAssignment.isAssignmentExpired(a)).toBe(false);
  });

  test('endDate strictly in the past ⇒ expired', () => {
    const a = makeAssignment({ endDate: '2020-01-01T00:00:00.000Z' });
    expect(ToolAssignment.isAssignmentExpired(a)).toBe(true);
  });

  test('endDate is today (date-only) ⇒ NOT expired until 23:59:59', () => {
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(today.getUTCDate()).padStart(2, '0');
    const a = makeAssignment({ endDate: `${yyyy}-${mm}-${dd}` });

    const noon = new Date(Date.UTC(yyyy, today.getUTCMonth(), today.getUTCDate(), 12, 0, 0));
    expect(ToolAssignment.isAssignmentExpired(a, noon)).toBe(false);

    // 1ms past end-of-day should be expired.
    const justAfter = new Date(Date.UTC(yyyy, today.getUTCMonth(), today.getUTCDate(), 23, 59, 60, 0));
    expect(ToolAssignment.isAssignmentExpired(a, justAfter)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findActiveForClientTool (DB layer, mocked)
// ---------------------------------------------------------------------------

describe('ToolAssignment.findActiveForClientTool', () => {
  const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const past   = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  test('returns null when no assignment exists for the tool', async () => {
    mockFind([
      makeAssignment({ toolId: 'tool-other', endDate: future }),
    ]);
    const { assignment, candidates } =
      await ToolAssignment.findActiveForClientTool('client-1', 'tool-1');
    expect(assignment).toBeNull();
    expect(candidates).toEqual([]); // wrong-tool rows are not candidates
  });

  test('returns null + candidates when all rows for the tool are expired', async () => {
    mockFind([
      makeAssignment({ _id: 'a1', endDate: past }),
      makeAssignment({ _id: 'a2', endDate: past }),
    ]);
    const { assignment, candidates } =
      await ToolAssignment.findActiveForClientTool('client-1', 'tool-1');
    expect(assignment).toBeNull();
    expect(candidates).toHaveLength(2);
  });

  test('with duplicate active+expired rows, LATEST valid wins', async () => {
    mockFind([
      makeAssignment({ _id: 'a-old', endDate: past }),                 // expired
      makeAssignment({ _id: 'a-new', endDate: future }),               // valid
      makeAssignment({ _id: 'a-newest', endDate: null }),              // valid, no expiry
    ]);
    const { assignment } =
      await ToolAssignment.findActiveForClientTool('client-1', 'tool-1');
    // null endDate is treated as "no expiry" (furthest boundary), so it wins.
    expect(assignment._id).toBe('a-newest');
  });

  test('between two valid rows, the one with the later endDate wins', async () => {
    const soon  = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const later = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    mockFind([
      makeAssignment({ _id: 'a-soon',  endDate: soon }),
      makeAssignment({ _id: 'a-later', endDate: later }),
    ]);
    const { assignment } =
      await ToolAssignment.findActiveForClientTool('client-1', 'tool-1');
    expect(assignment._id).toBe('a-later');
  });

  test('toolId comparison normalises to string (number vs string)', async () => {
    mockFind([
      // populated tool id is a NUMBER, request comes in as a STRING
      makeAssignment({ _id: 'a1', toolId: 42, endDate: future }),
    ]);
    const { assignment } =
      await ToolAssignment.findActiveForClientTool('client-1', '42');
    expect(assignment).not.toBeNull();
    expect(assignment._id).toBe('a1');
  });

  test('assignment with future startDate is filtered out', async () => {
    const futureStart = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    mockFind([
      makeAssignment({ _id: 'a-future', startDate: futureStart, endDate: future }),
    ]);
    const { assignment, candidates } =
      await ToolAssignment.findActiveForClientTool('client-1', 'tool-1');
    expect(assignment).toBeNull();
    expect(candidates).toHaveLength(1); // row exists, just not yet valid
  });

  test('assignment whose populated tool is inactive is filtered out', async () => {
    mockFind([
      makeAssignment({ _id: 'a1', toolStatus: 'inactive', endDate: future }),
    ]);
    const { assignment } =
      await ToolAssignment.findActiveForClientTool('client-1', 'tool-1');
    expect(assignment).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getClientAccessibleTool (orchestrator) — the access-flow contract
// ---------------------------------------------------------------------------

describe('getClientAccessibleTool', () => {
  const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const past   = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  test('returns assignment_not_found when clientId or toolId is missing', async () => {
    const a = await getClientAccessibleTool(null, 'tool-1');
    expect(a).toEqual({ ok: false, code: 'assignment_not_found', candidates: [] });

    const b = await getClientAccessibleTool('client-1', null);
    expect(b).toEqual({ ok: false, code: 'assignment_not_found', candidates: [] });
  });

  test('returns assignment_not_found when there are zero rows for the tool', async () => {
    mockFind([]); // no rows at all
    const res = await getClientAccessibleTool('client-1', 'tool-1');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('assignment_not_found');
    expect(res.candidates).toEqual([]);
  });

  test('distinguishes assignment_expired from assignment_not_found', async () => {
    mockFind([
      makeAssignment({ _id: 'a1', endDate: past }),
    ]);
    const res = await getClientAccessibleTool('client-1', 'tool-1');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('assignment_expired');
    expect(res.candidates).toHaveLength(1);
  });

  test('returns ok:true with tool + assignment when a valid row exists', async () => {
    mockFind([
      makeAssignment({ _id: 'a1', endDate: future }),
    ]);
    const res = await getClientAccessibleTool('client-1', 'tool-1');
    expect(res.ok).toBe(true);
    expect(res.assignment._id).toBe('a1');
    expect(res.tool._id).toBe('tool-1');
  });

  test('valid row coexisting with expired row ⇒ ok:true, dashboard==access', async () => {
    mockFind([
      makeAssignment({ _id: 'a-old', endDate: past }),
      makeAssignment({ _id: 'a-new', endDate: future }),
    ]);
    const res = await getClientAccessibleTool('client-1', 'tool-1');
    expect(res.ok).toBe(true);
    expect(res.assignment._id).toBe('a-new');
  });

  test('toolId is normalised to string before comparison', async () => {
    mockFind([
      makeAssignment({ _id: 'a1', toolId: '42', endDate: future }),
    ]);
    const res = await getClientAccessibleTool('client-1', 42);
    expect(res.ok).toBe(true);
    expect(res.tool._id).toBe('42');
  });
});

// ---------------------------------------------------------------------------
// listClientAccessibleTools — dashboard list contract
// ---------------------------------------------------------------------------

describe('listClientAccessibleTools', () => {
  const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const past   = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  beforeEach(() => {
    jest.spyOn(ToolAssignment, 'updateExpiredAssignments').mockResolvedValue();
  });

  test('returns [] when clientId is missing', async () => {
    const res = await listClientAccessibleTools();
    expect(res).toEqual([]);
  });

  test('returns one entry per tool, latest boundary wins', async () => {
    const soon  = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const later = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    mockFind([
      makeAssignment({ _id: 'a1', toolId: 'tool-1', endDate: soon }),
      makeAssignment({ _id: 'a2', toolId: 'tool-1', endDate: later }),
      makeAssignment({ _id: 'a3', toolId: 'tool-2', endDate: future }),
      makeAssignment({ _id: 'a4', toolId: 'tool-3', endDate: past }), // expired ⇒ dropped
    ]);
    const res = await listClientAccessibleTools('client-1');
    const byTool = Object.fromEntries(res.map(r => [r.tool._id, r.assignment._id]));
    expect(byTool['tool-1']).toBe('a2');
    expect(byTool['tool-2']).toBe('a3');
    expect(byTool['tool-3']).toBeUndefined();
  });

  test('inactive tool rows are dropped from the list', async () => {
    mockFind([
      makeAssignment({ _id: 'a1', toolId: 'tool-1', toolStatus: 'inactive', endDate: future }),
    ]);
    const res = await listClientAccessibleTools('client-1');
    expect(res).toEqual([]);
  });

  test('dashboard list and per-tool getter MUST agree (no divergence)', async () => {
    // Same row set served to BOTH calls — verifies the invariant that
    // "if dashboard shows the tool, Access cannot say expired".
    const rows = [
      makeAssignment({ _id: 'a-old', toolId: 'tool-1', endDate: past }),
      makeAssignment({ _id: 'a-new', toolId: 'tool-1', endDate: future }),
    ];
    mockFind(rows);
    const list = await listClientAccessibleTools('client-1');
    expect(list).toHaveLength(1);
    expect(list[0].assignment._id).toBe('a-new');

    mockFind(rows);
    const one = await getClientAccessibleTool('client-1', 'tool-1');
    expect(one.ok).toBe(true);
    expect(one.assignment._id).toBe('a-new');
  });
});
