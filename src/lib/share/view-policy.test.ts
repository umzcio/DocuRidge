import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { shouldRecordShareView, resolveShareViewWindowMs } from './view-policy';

const ORIGINAL_WINDOW_ENV = process.env.SHARE_VIEW_AUDIT_WINDOW_MINUTES;
const MINUTE_MS = 60 * 1000;

function minutesAgo(now: Date, minutes: number): Date {
  return new Date(now.getTime() - minutes * MINUTE_MS);
}

function minutesFromNow(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * MINUTE_MS);
}

describe('shouldRecordShareView', () => {
  beforeEach(() => {
    delete process.env.SHARE_VIEW_AUDIT_WINDOW_MINUTES;
  });

  afterAll(() => {
    if (ORIGINAL_WINDOW_ENV === undefined) {
      delete process.env.SHARE_VIEW_AUDIT_WINDOW_MINUTES;
    } else {
      process.env.SHARE_VIEW_AUDIT_WINDOW_MINUTES = ORIGINAL_WINDOW_ENV;
    }
  });

  const now = new Date('2026-08-29T12:00:00.000Z');

  it('records the first view (null lastViewedAt)', () => {
    expect(shouldRecordShareView(null, now)).toBe(true);
  });

  it('the flooding guard: a view 1 minute after the last one does NOT record', () => {
    expect(shouldRecordShareView(minutesAgo(now, 1), now)).toBe(false);
  });

  it('does not record at 59 minutes (just under the default window)', () => {
    expect(shouldRecordShareView(minutesAgo(now, 59), now)).toBe(false);
  });

  it('records at exactly 60 minutes (boundary is inclusive)', () => {
    expect(shouldRecordShareView(minutesAgo(now, 60), now)).toBe(true);
  });

  it('records at 61 minutes (past the default window)', () => {
    expect(shouldRecordShareView(minutesAgo(now, 61), now)).toBe(true);
  });

  it('with a 5-minute window, records at 6 minutes', () => {
    process.env.SHARE_VIEW_AUDIT_WINDOW_MINUTES = '5';
    expect(shouldRecordShareView(minutesAgo(now, 6), now)).toBe(true);
  });

  it('with a 5-minute window, does not record at 4 minutes', () => {
    process.env.SHARE_VIEW_AUDIT_WINDOW_MINUTES = '5';
    expect(shouldRecordShareView(minutesAgo(now, 4), now)).toBe(false);
  });

  it('records when lastViewedAt is in the future (clock skew)', () => {
    expect(shouldRecordShareView(minutesFromNow(now, 10), now)).toBe(true);
  });

  it('falls back to 60 minutes for a non-numeric window and does not throw', () => {
    process.env.SHARE_VIEW_AUDIT_WINDOW_MINUTES = 'not-a-number';
    expect(() => shouldRecordShareView(minutesAgo(now, 61), now)).not.toThrow();
    expect(shouldRecordShareView(minutesAgo(now, 61), now)).toBe(true);
    expect(shouldRecordShareView(minutesAgo(now, 1), now)).toBe(false);
  });

  it('falls back to 60 minutes for a "0" window and does not throw', () => {
    process.env.SHARE_VIEW_AUDIT_WINDOW_MINUTES = '0';
    expect(() => shouldRecordShareView(minutesAgo(now, 1), now)).not.toThrow();
    expect(shouldRecordShareView(minutesAgo(now, 1), now)).toBe(false);
    expect(shouldRecordShareView(minutesAgo(now, 61), now)).toBe(true);
  });

  it('falls back to 60 minutes for a negative window and does not throw', () => {
    process.env.SHARE_VIEW_AUDIT_WINDOW_MINUTES = '-5';
    expect(() => shouldRecordShareView(minutesAgo(now, 1), now)).not.toThrow();
    expect(shouldRecordShareView(minutesAgo(now, 1), now)).toBe(false);
    expect(shouldRecordShareView(minutesAgo(now, 61), now)).toBe(true);
  });
});

describe('resolveShareViewWindowMs', () => {
  beforeEach(() => {
    delete process.env.SHARE_VIEW_AUDIT_WINDOW_MINUTES;
  });

  afterAll(() => {
    if (ORIGINAL_WINDOW_ENV === undefined) {
      delete process.env.SHARE_VIEW_AUDIT_WINDOW_MINUTES;
    } else {
      process.env.SHARE_VIEW_AUDIT_WINDOW_MINUTES = ORIGINAL_WINDOW_ENV;
    }
  });

  it('defaults to 60 minutes in milliseconds', () => {
    expect(resolveShareViewWindowMs()).toBe(60 * MINUTE_MS);
  });

  it('honors an explicit valid window', () => {
    process.env.SHARE_VIEW_AUDIT_WINDOW_MINUTES = '5';
    expect(resolveShareViewWindowMs()).toBe(5 * MINUTE_MS);
  });
});
