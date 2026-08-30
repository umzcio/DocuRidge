import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { shouldWriteHeartbeat } from './heartbeat';

const ORIGINAL_ENV = process.env.SESSION_HEARTBEAT_SECONDS;

describe('shouldWriteHeartbeat', () => {
  beforeEach(() => {
    delete process.env.SESSION_HEARTBEAT_SECONDS;
  });

  afterAll(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.SESSION_HEARTBEAT_SECONDS;
    } else {
      process.env.SESSION_HEARTBEAT_SECONDS = ORIGINAL_ENV;
    }
  });

  it('the guard: does not write a 1-second-old heartbeat at the default interval', () => {
    const now = new Date('2026-01-01T00:01:00.000Z');
    const lastSeenAt = new Date('2026-01-01T00:00:59.000Z');
    expect(shouldWriteHeartbeat(lastSeenAt, now)).toBe(false);
  });

  it('does not write at 59 seconds old (default interval)', () => {
    const now = new Date('2026-01-01T00:01:00.000Z');
    const lastSeenAt = new Date('2026-01-01T00:00:01.000Z');
    expect(shouldWriteHeartbeat(lastSeenAt, now)).toBe(false);
  });

  it('writes at exactly 60 seconds old (default interval)', () => {
    const now = new Date('2026-01-01T00:01:00.000Z');
    const lastSeenAt = new Date('2026-01-01T00:00:00.000Z');
    expect(shouldWriteHeartbeat(lastSeenAt, now)).toBe(true);
  });

  it('writes at 61 seconds old (default interval)', () => {
    const now = new Date('2026-01-01T00:01:01.000Z');
    const lastSeenAt = new Date('2026-01-01T00:00:00.000Z');
    expect(shouldWriteHeartbeat(lastSeenAt, now)).toBe(true);
  });

  it('SESSION_HEARTBEAT_SECONDS=0 always writes, even 1 second ago (opt-out)', () => {
    process.env.SESSION_HEARTBEAT_SECONDS = '0';
    const now = new Date('2026-01-01T00:00:01.000Z');
    const lastSeenAt = new Date('2026-01-01T00:00:00.000Z');
    expect(shouldWriteHeartbeat(lastSeenAt, now)).toBe(true);
  });

  it('SESSION_HEARTBEAT_SECONDS=300 does not write at 200 seconds old', () => {
    process.env.SESSION_HEARTBEAT_SECONDS = '300';
    const now = new Date('2026-01-01T00:03:20.000Z'); // +200s
    const lastSeenAt = new Date('2026-01-01T00:00:00.000Z');
    expect(shouldWriteHeartbeat(lastSeenAt, now)).toBe(false);
  });

  it('SESSION_HEARTBEAT_SECONDS=300 writes at 400 seconds old', () => {
    process.env.SESSION_HEARTBEAT_SECONDS = '300';
    const now = new Date('2026-01-01T00:06:40.000Z'); // +400s
    const lastSeenAt = new Date('2026-01-01T00:00:00.000Z');
    expect(shouldWriteHeartbeat(lastSeenAt, now)).toBe(true);
  });

  it('writes when lastSeenAt is 10 minutes in the future (clock skew cannot suppress forever)', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const lastSeenAt = new Date('2026-01-01T00:10:00.000Z');
    expect(shouldWriteHeartbeat(lastSeenAt, now)).toBe(true);
  });

  it('falls back to 60 and does not throw on a non-numeric value', () => {
    process.env.SESSION_HEARTBEAT_SECONDS = 'not-a-number';
    const now = new Date('2026-01-01T00:00:59.000Z');
    const lastSeenAt = new Date('2026-01-01T00:00:00.000Z');
    expect(() => shouldWriteHeartbeat(lastSeenAt, now)).not.toThrow();
    expect(shouldWriteHeartbeat(lastSeenAt, now)).toBe(false);

    const laterNow = new Date('2026-01-01T00:01:00.000Z');
    expect(shouldWriteHeartbeat(lastSeenAt, laterNow)).toBe(true);
  });

  it('falls back to 60 and does not throw on a negative value', () => {
    process.env.SESSION_HEARTBEAT_SECONDS = '-5';
    const now = new Date('2026-01-01T00:00:59.000Z');
    const lastSeenAt = new Date('2026-01-01T00:00:00.000Z');
    expect(() => shouldWriteHeartbeat(lastSeenAt, now)).not.toThrow();
    expect(shouldWriteHeartbeat(lastSeenAt, now)).toBe(false);

    const laterNow = new Date('2026-01-01T00:01:00.000Z');
    expect(shouldWriteHeartbeat(lastSeenAt, laterNow)).toBe(true);
  });
});
