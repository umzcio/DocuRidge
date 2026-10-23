import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  configuredToken: '',
  stateFind: vi.fn(),
  stateUpdate: vi.fn(),
  userFind: vi.fn(),
  userUpdate: vi.fn(),
  transaction: vi.fn(),
  recordEvent: vi.fn(),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ BOOTSTRAP_TOKEN: mocks.configuredToken, PASSWORD_MIN_LENGTH: 12 }),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    bootstrapState: { findUnique: mocks.stateFind, update: mocks.stateUpdate },
    user: { findUnique: mocks.userFind, update: mocks.userUpdate },
    $transaction: mocks.transaction,
  },
}));
vi.mock('@/lib/auth/argon', () => ({ hashPassword: async () => 'argon2id$hash' }));
vi.mock('@/lib/audit/user-security', () => ({ recordUserSecurityEvent: mocks.recordEvent }));
vi.mock('@/lib/auth/session', () => ({ captureClientContext: () => ({ ipAddress: '203.0.113.5' }) }));
vi.mock('@/lib/logger', () => ({ childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { setupAction } from './actions';

const TOKEN_A = 'first-boot-token-AAAAAAAAAAAAAAAA';
const TOKEN_B = 'rotated-token-BBBBBBBBBBBBBBBBBBBB';
const sha = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');

function submit(token: string) {
  const data = new FormData();
  data.set('bootstrapToken', token);
  data.set('password', 'Correct-Horse-Battery-9');
  return setupAction({ ok: false }, data);
}

function pendingState(tokenHash: string) {
  return { id: 1, pendingAdminUserId: 'admin_1', tokenHash, completedAt: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFind.mockResolvedValue({ id: 'admin_1' });
  mocks.transaction.mockResolvedValue([]);
});

describe('setupAction — only the currently configured BOOTSTRAP_TOKEN is accepted', () => {
  it('accepts the first-boot token when it is still the configured one', async () => {
    mocks.configuredToken = TOKEN_A;
    mocks.stateFind.mockResolvedValue(pendingState(sha(TOKEN_A)));
    const result = await submit(TOKEN_A);
    expect(result).toEqual({ ok: true, message: 'Setup complete.' });
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });

  it('rejects the first-boot token after the operator rotated to a new one', async () => {
    // First boot stored hash(A); operator then set BOOTSTRAP_TOKEN=B and restarted.
    mocks.configuredToken = TOKEN_B;
    mocks.stateFind.mockResolvedValue(pendingState(sha(TOKEN_A)));
    const result = await submit(TOKEN_A);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Bootstrap token is incorrect.');
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('accepts the rotated token even if the stored hash still belongs to the old one', async () => {
    mocks.configuredToken = TOKEN_B;
    mocks.stateFind.mockResolvedValue(pendingState(sha(TOKEN_A)));
    const result = await submit(TOKEN_B);
    expect(result.ok).toBe(true);
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });

  it('rejects a token that was never configured', async () => {
    mocks.configuredToken = TOKEN_B;
    mocks.stateFind.mockResolvedValue(pendingState(sha(TOKEN_B)));
    const result = await submit('guessed-token-CCCCCCCCCCCCCCCCCCCC');
    expect(result).toMatchObject({ ok: false, error: 'Bootstrap token is incorrect.' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects even the configured token once setup is complete', async () => {
    mocks.configuredToken = TOKEN_B;
    mocks.stateFind.mockResolvedValue({ ...pendingState(sha(TOKEN_B)), completedAt: new Date() });
    const result = await submit(TOKEN_B);
    expect(result).toMatchObject({ ok: false, error: 'Setup has already been completed.' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
