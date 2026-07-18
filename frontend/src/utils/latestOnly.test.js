import { makeLatestGuard } from './latestOnly';

describe('makeLatestGuard (stale-response guard for the client picker)', () => {
  test('only the most recently started ticket is current', () => {
    const g = makeLatestGuard();
    const t1 = g.begin();
    const t2 = g.begin();
    expect(g.isCurrent(t1)).toBe(false);
    expect(g.isCurrent(t2)).toBe(true);
  });

  test('an OLD response resolving after a NEWER one started is dropped', () => {
    const g = makeLatestGuard();
    // Two overlapping searches; the newer one starts before either resolves.
    const older = g.begin(); // e.g. "pet"
    const newer = g.begin(); // e.g. "peter"

    const committed = [];
    // Simulate out-of-order resolution: the NEWER response comes back first…
    if (g.isCurrent(newer)) committed.push('peter');
    // …then the OLDER (stale) response resolves and must be ignored.
    if (g.isCurrent(older)) committed.push('pet');

    expect(committed).toEqual(['peter']);
  });

  test('the latest of many concurrent requests always wins', () => {
    const g = makeLatestGuard();
    const tickets = [g.begin(), g.begin(), g.begin(), g.begin()];
    const survivors = tickets.filter((t) => g.isCurrent(t));
    expect(survivors).toEqual([tickets[3]]);
    expect(g.current()).toBe(tickets[3]);
  });
});
