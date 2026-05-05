import { describe, it, expect, beforeAll } from 'vitest';
import { mintSigningToken, verifySigningToken } from './token';

beforeAll(() => {
  // Provide all required env vars; the test only exercises token mint/verify.
  process.env.PUBLIC_URL = 'https://test.example/DocuRidge';
  process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test';
  process.env.SESSION_SECRET = 'x'.repeat(32);
  process.env.JWS_SIGNING_TOKEN_SECRET = 'y'.repeat(32);
  process.env.JWS_RESET_TOKEN_SECRET = 'z'.repeat(32);
  process.env.BOOTSTRAP_TOKEN = 'abcdefghijklmnop';
  (process.env as Record<string, string>).NODE_ENV = 'test';
});

describe('signing tokens', () => {
  it('round-trip: mints a token and verifies it back to the same claims', async () => {
    const m = await mintSigningToken({ envelopeId: 'env_1', recipientId: 'rcp_1' });
    const claims = await verifySigningToken(m.token);
    expect(claims).not.toBeNull();
    expect(claims!.envelopeId).toBe('env_1');
    expect(claims!.recipientId).toBe('rcp_1');
    expect(claims!.jti).toBe(m.jti);
  });

  it('rejects a tampered token', async () => {
    const m = await mintSigningToken({ envelopeId: 'env_1', recipientId: 'rcp_1' });
    // Flip a character in the body.
    const parts = m.token.split('.');
    const flipped = `${parts[0]}.${parts[1]!.slice(0, -1)}A.${parts[2]}`;
    expect(await verifySigningToken(flipped)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const m = await mintSigningToken({
      envelopeId: 'env_2',
      recipientId: 'rcp_2',
      ttlSeconds: -10,
    });
    expect(await verifySigningToken(m.token)).toBeNull();
  });

  it('different envelopes produce different jti', async () => {
    const a = await mintSigningToken({ envelopeId: 'env_a', recipientId: 'rcp_a' });
    const b = await mintSigningToken({ envelopeId: 'env_b', recipientId: 'rcp_b' });
    expect(a.jti).not.toBe(b.jti);
    expect(a.token).not.toBe(b.token);
  });

  it('rejects garbage', async () => {
    expect(await verifySigningToken('')).toBeNull();
    expect(await verifySigningToken('not.a.token')).toBeNull();
    expect(await verifySigningToken('aaaa.bbbb.cccc')).toBeNull();
  });
});
