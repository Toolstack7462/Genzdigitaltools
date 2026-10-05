import { createLatestOnly } from '../latestOnly';

describe('createLatestOnly', () => {
  it('applies responses that arrive in order', () => {
    const g = createLatestOnly();
    const a = g.issue(); const b = g.issue();
    expect(g.accept(a)).toBe(true);
    expect(g.accept(b)).toBe(true);
  });

  it('drops an OLDER response that arrives after a newer one was applied', () => {
    const g = createLatestOnly();
    const slowOld = g.issue();
    const fastNew = g.issue();
    expect(g.accept(fastNew)).toBe(true);
    expect(g.accept(slowOld)).toBe(false);
  });

  it('a later request still applies after a dropped one', () => {
    const g = createLatestOnly();
    const a = g.issue(); const b = g.issue();
    g.accept(b); g.accept(a);
    const c = g.issue();
    expect(g.accept(c)).toBe(true);
  });
});
