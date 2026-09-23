import { COOKIE_INVENTORY } from './cookie-inventory';

/**
 * Drift guard. A published cookie list is only worth anything while it matches what the
 * code actually sets: if a writer is renamed or dropped, this fails instead of letting the
 * policy and the banner keep claiming a cookie that no longer exists (or miss a new one).
 *
 * `_ga` is Google's, set by GA4 after a grant (`app.config.ts`), so it has no writer here.
 */
describe('cookie inventory', () => {
  /** Every cookie this repo's own writers set. Update alongside the writer that changes. */
  const SET_BY_CODE = ['_csrf', '_csrf_secret', 'consent', 'gid', 'guest_fp', 'aid', 'device_id'];

  it('lists every cookie the code sets', () => {
    const names = COOKIE_INVENTORY.map((cookie) => cookie.name).join(' | ');

    for (const name of SET_BY_CODE) {
      expect(names).toContain(name);
    }
  });

  it('lists nothing twice, and nothing without retention or purpose', () => {
    const names = COOKIE_INVENTORY.map((cookie) => cookie.name);

    expect(new Set(names).size).toBe(names.length);
    for (const cookie of COOKIE_INVENTORY) {
      expect(cookie.duration.length).toBeGreaterThan(0);
      expect(cookie.purpose.length).toBeGreaterThan(20);
    }
  });

  it('keeps every cookie in a category the banner exposes', () => {
    const categories = new Set(COOKIE_INVENTORY.map((cookie) => cookie.category));

    expect([...categories].sort()).toEqual(['analytics', 'functional', 'necessary']);
  });
});
