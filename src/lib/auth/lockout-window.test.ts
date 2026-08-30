import { describe, expect, it } from 'vitest';
import { isWithinLockoutWindow } from './lockout';

const NOW = new Date('2026-08-30T12:00:00.000Z');

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60 * 1000);
}

function minutesFromNow(minutes: number): Date {
  return new Date(NOW.getTime() + minutes * 60 * 1000);
}

describe('isWithinLockoutWindow', () => {
  it('returns false for a null anchor (starts a new series)', () => {
    expect(isWithinLockoutWindow(null, 15, NOW)).toBe(false);
  });

  it('returns true when the anchor is 1 minute ago within a 15-minute window', () => {
    expect(isWithinLockoutWindow(minutesAgo(1), 15, NOW)).toBe(true);
  });

  it('returns true when the anchor is 14m59s ago within a 15-minute window', () => {
    const anchor = new Date(NOW.getTime() - (14 * 60 * 1000 + 59 * 1000));
    expect(isWithinLockoutWindow(anchor, 15, NOW)).toBe(true);
  });

  it('returns false at exactly the 15-minute boundary (starts a new series)', () => {
    expect(isWithinLockoutWindow(minutesAgo(15), 15, NOW)).toBe(false);
  });

  it('returns false when the anchor is 16 minutes ago', () => {
    expect(isWithinLockoutWindow(minutesAgo(16), 15, NOW)).toBe(false);
  });

  it('regression: an anchor 20 minutes ago is out of window even though the row was "recently updated"', () => {
    // This is the bug this plan fixes: the old implementation measured the
    // window from `updatedAt`, so a recent unrelated write to the row (e.g.
    // the failed-attempt increment itself, a profile change) would keep the
    // series alive indefinitely. The window must be measured from the first
    // failure of the series, not from any row activity.
    expect(isWithinLockoutWindow(minutesAgo(20), 15, NOW)).toBe(false);
  });

  it('returns false for a future anchor (clock skew) so skew cannot suppress counting forever', () => {
    expect(isWithinLockoutWindow(minutesFromNow(10), 15, NOW)).toBe(false);
  });

  it('falls back to the default 15-minute window and does not throw for windowMinutes of 0, negative, or NaN', () => {
    // 10 minutes ago is inside a 15-minute default window.
    expect(() => isWithinLockoutWindow(minutesAgo(10), 0, NOW)).not.toThrow();
    expect(isWithinLockoutWindow(minutesAgo(10), 0, NOW)).toBe(true);

    expect(() => isWithinLockoutWindow(minutesAgo(10), -5, NOW)).not.toThrow();
    expect(isWithinLockoutWindow(minutesAgo(10), -5, NOW)).toBe(true);

    expect(() => isWithinLockoutWindow(minutesAgo(10), NaN, NOW)).not.toThrow();
    expect(isWithinLockoutWindow(minutesAgo(10), NaN, NOW)).toBe(true);

    // 20 minutes ago is outside the 15-minute default window.
    expect(isWithinLockoutWindow(minutesAgo(20), NaN, NOW)).toBe(false);
  });

  it('honors a custom window: true at 4 minutes, false at 6 minutes for a 5-minute window', () => {
    expect(isWithinLockoutWindow(minutesAgo(4), 5, NOW)).toBe(true);
    expect(isWithinLockoutWindow(minutesAgo(6), 5, NOW)).toBe(false);
  });
});
