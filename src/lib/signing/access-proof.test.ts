import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('../env', () => ({
  getEnv: () => ({ JWS_SIGNING_TOKEN_SECRET: 'x'.repeat(48) }),
}));

import { mintAccessProof, verifyAccessProof } from './access-proof';
import { mintSigningToken } from './token';

const binding = {
  envelopeId: 'env1',
  recipientId: 'r1',
  jti: 'jti-current',
  accessCodeHash: 'a'.repeat(64),
};

afterEach(() => {
  vi.useRealTimers();
});

describe('access-code unlock proof', () => {
  it('verifies for the exact envelope, recipient, signing-token jti and code it was minted for', async () => {
    const { token } = await mintAccessProof(binding);
    expect(await verifyAccessProof(token, binding)).toBe(true);
  });

  it('is refused for a different recipient', async () => {
    const { token } = await mintAccessProof(binding);
    expect(await verifyAccessProof(token, { ...binding, recipientId: 'r2' })).toBe(false);
  });

  it('is refused for a different envelope', async () => {
    const { token } = await mintAccessProof(binding);
    expect(await verifyAccessProof(token, { ...binding, envelopeId: 'env2' })).toBe(false);
  });

  it('is refused once the signing token is re-minted (reassign, reminder): the jti changed', async () => {
    const { token } = await mintAccessProof(binding);
    expect(await verifyAccessProof(token, { ...binding, jti: 'jti-after-reassign' })).toBe(false);
  });

  it('is refused once the access code itself changes', async () => {
    const { token } = await mintAccessProof(binding);
    expect(await verifyAccessProof(token, { ...binding, accessCodeHash: 'b'.repeat(64) })).toBe(false);
  });

  it('expires', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-24T10:00:00Z') });
    const { token, expiresAt } = await mintAccessProof(binding, 60);
    expect(expiresAt.toISOString()).toBe('2026-10-24T10:01:00.000Z');
    vi.setSystemTime(new Date('2026-10-24T10:02:00Z'));
    expect(await verifyAccessProof(token, binding)).toBe(false);
  });

  it('a signing token (same secret, other audience) is not accepted as a proof', async () => {
    const minted = await mintSigningToken({ envelopeId: 'env1', recipientId: 'r1' });
    expect(await verifyAccessProof(minted.token, { ...binding, jti: minted.jti })).toBe(false);
  });

  it('rejects a tampered, empty or missing value', async () => {
    const { token } = await mintAccessProof(binding);
    const [h, p, s] = token.split('.');
    const flipped = `${h}.${p}.${s!.slice(0, -2)}${s!.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(await verifyAccessProof(flipped, binding)).toBe(false);
    expect(await verifyAccessProof('', binding)).toBe(false);
    expect(await verifyAccessProof(undefined, binding)).toBe(false);
  });
});
