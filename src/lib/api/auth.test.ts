import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findUnique, update } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { apiToken: { findUnique, update } },
}));

import { authenticateApiRequest, requireScope, generateApiToken } from './auth';

function reqWithAuth(header?: string): Request {
  const headers = new Headers();
  if (header !== undefined) headers.set('authorization', header);
  return new Request('http://localhost/api/v1/envelopes', { headers });
}

const VALID_TOKEN = 'dr_' + 'a'.repeat(32);

const BASE_ROW = {
  id: 'tok_1',
  orgId: 'org_1',
  userId: 'user_1',
  scopes: 'read,write',
  tokenHash: 'hash',
  revokedAt: null,
  expiresAt: null,
  lastUsedAt: null,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
};

describe('authenticateApiRequest', () => {
  beforeEach(() => {
    findUnique.mockReset();
    update.mockReset();
  });

  it('accepts a valid token and parses scopes', async () => {
    findUnique.mockResolvedValue({ ...BASE_ROW });
    const result = await authenticateApiRequest(reqWithAuth(`Bearer ${VALID_TOKEN}`));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token.id).toBe('tok_1');
      expect(result.token.orgId).toBe('org_1');
      expect(result.token.userId).toBe('user_1');
      expect(result.token.scopes).toEqual(['read', 'write']);
    }
    // Fresh lastUsedAt (null) → touch happens.
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('touches lastUsedAt only when the previous touch is older than 60 s', async () => {
    findUnique.mockResolvedValue({
      ...BASE_ROW,
      lastUsedAt: new Date(Date.now() - 30_000),
    });
    const result = await authenticateApiRequest(reqWithAuth(`Bearer ${VALID_TOKEN}`));
    expect(result.ok).toBe(true);
    expect(update).not.toHaveBeenCalled();

    findUnique.mockResolvedValue({
      ...BASE_ROW,
      lastUsedAt: new Date(Date.now() - 61_000),
    });
    const result2 = await authenticateApiRequest(reqWithAuth(`Bearer ${VALID_TOKEN}`));
    expect(result2.ok).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing Authorization header', async () => {
    const result = await authenticateApiRequest(reqWithAuth(undefined));
    expect(result).toEqual({ ok: false, status: 401, error: expect.any(String) });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rejects a malformed token (bad prefix, wrong length) with 401 and no DB lookup', async () => {
    for (const bad of ['Bearer nope_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Bearer dr_short', 'dr_' + 'a'.repeat(32), 'Bearer dr_' + 'a'.repeat(31)]) {
      const result = await authenticateApiRequest(reqWithAuth(bad));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(401);
    }
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rejects an unknown token hash', async () => {
    findUnique.mockResolvedValue(null);
    const result = await authenticateApiRequest(reqWithAuth(`Bearer ${VALID_TOKEN}`));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('rejects a revoked token', async () => {
    findUnique.mockResolvedValue({ ...BASE_ROW, revokedAt: new Date() });
    const result = await authenticateApiRequest(reqWithAuth(`Bearer ${VALID_TOKEN}`));
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects an expired token', async () => {
    findUnique.mockResolvedValue({ ...BASE_ROW, expiresAt: new Date(Date.now() - 1000) });
    const result = await authenticateApiRequest(reqWithAuth(`Bearer ${VALID_TOKEN}`));
    expect(result).toMatchObject({ ok: false, status: 401 });
  });
});

describe('requireScope', () => {
  it('returns null when the scope is present', () => {
    const auth = { ok: true as const, token: { id: 't', orgId: 'o', userId: 'u', scopes: ['read', 'write'] } };
    expect(requireScope(auth, 'write')).toBeNull();
    expect(requireScope(auth, 'read')).toBeNull();
  });

  it('returns a 403-shaped error when the scope is missing', () => {
    const auth = { ok: true as const, token: { id: 't', orgId: 'o', userId: 'u', scopes: ['read'] } };
    const err = requireScope(auth, 'write');
    expect(err).toMatchObject({ status: 403 });
    expect(err!.error).toMatch(/write/);
  });
});

describe('generateApiToken', () => {
  it('produces dr_ + 32 url-safe chars and a sha256 hash', () => {
    const { plaintext, tokenHash } = generateApiToken();
    expect(plaintext).toMatch(/^dr_[A-Za-z0-9_-]{32}$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces unique tokens', () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a.plaintext).not.toBe(b.plaintext);
  });
});
