import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// getLogger() memoizes into a module-level `cached`, so each case below
// resets the module registry and re-imports dynamically to get a fresh
// instance — otherwise only the first case would exercise the resolution
// logic.

const REQUIRED_SECRETS = [
  'PUBLIC_URL',
  'DATABASE_URL',
  'SESSION_SECRET',
  'JWS_SIGNING_TOKEN_SECRET',
  'JWS_RESET_TOKEN_SECRET',
  'BOOTSTRAP_TOKEN',
] as const;

// Only the keys these tests touch — restoring the whole process.env object
// would fight TypeScript's ProcessEnv type (NODE_ENV is required on it), and
// it's more than these tests need.
const TOUCHED_KEYS = [...REQUIRED_SECRETS, 'LOG_LEVEL'] as const;

let saved: Partial<Record<(typeof TOUCHED_KEYS)[number], string>>;

beforeEach(() => {
  saved = {};
  for (const key of TOUCHED_KEYS) {
    saved[key] = process.env[key];
  }
});

afterEach(() => {
  for (const key of TOUCHED_KEYS) {
    const value = saved[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.resetModules();
});

describe('getLogger / childLogger — regression guard', () => {
  it('does not throw when all six required secrets are absent', async () => {
    for (const name of REQUIRED_SECRETS) {
      delete process.env[name];
    }
    vi.resetModules();
    const { childLogger } = await import('./logger');
    expect(() => childLogger({ m: 'x' })).not.toThrow();
  });
});

describe('getLogger — LOG_LEVEL resolution', () => {
  it('defaults to "info" when LOG_LEVEL is unset', async () => {
    delete process.env.LOG_LEVEL;
    vi.resetModules();
    const { getLogger } = await import('./logger');
    expect(getLogger().level).toBe('info');
  });

  it('uses LOG_LEVEL when it is a recognized level', async () => {
    process.env.LOG_LEVEL = 'debug';
    vi.resetModules();
    const { getLogger } = await import('./logger');
    expect(getLogger().level).toBe('debug');
  });

  it('falls back to "info" without throwing on an unrecognized LOG_LEVEL', async () => {
    process.env.LOG_LEVEL = 'not-a-level';
    vi.resetModules();
    const { getLogger } = await import('./logger');
    expect(() => getLogger()).not.toThrow();
    expect(getLogger().level).toBe('info');
  });
});

describe('childLogger', () => {
  it('returns a logger that inherits the resolved level', async () => {
    process.env.LOG_LEVEL = 'warn';
    vi.resetModules();
    const { childLogger } = await import('./logger');
    expect(childLogger({ module: 'test' }).level).toBe('warn');
  });
});
