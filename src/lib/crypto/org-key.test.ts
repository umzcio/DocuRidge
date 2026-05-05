import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { publicKeyFromPem } from './org-key';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

beforeAll(() => {
  // Avoid touching the real env loader for these pure-function tests.
  process.env.PUBLIC_URL = 'https://test.example/DocuRidge';
  process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test';
  process.env.SESSION_SECRET = 'x'.repeat(32);
  process.env.JWS_SIGNING_TOKEN_SECRET = 'y'.repeat(32);
  process.env.JWS_RESET_TOKEN_SECRET = 'z'.repeat(32);
  process.env.BOOTSTRAP_TOKEN = 'abcdefghijklmnop';
  (process.env as Record<string, string>).NODE_ENV = 'test';
});

describe('publicKeyFromPem', () => {
  it('round-trips a 32-byte public key through PEM wrapping', async () => {
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const b64 = Buffer.from(pub).toString('base64');
    const pem = `-----BEGIN DOCURIDGE ED25519 PUBLIC KEY-----\n${b64}\n-----END DOCURIDGE ED25519 PUBLIC KEY-----\n`;
    const back = publicKeyFromPem(pem);
    expect(Array.from(back)).toEqual(Array.from(pub));
  });

  it('rejects malformed PEM', () => {
    expect(() => publicKeyFromPem('not-a-pem')).toThrow();
    expect(() => publicKeyFromPem('-----BEGIN X-----\nQUFB\n-----END X-----')).toThrow();
  });
});

describe('Ed25519 round-trip and tamper detection', () => {
  it('signature verifies for the matching key + message', async () => {
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const msg = createHash('sha256').update('hello').digest();
    const sig = await ed.signAsync(msg, priv);
    expect(await ed.verifyAsync(sig, msg, pub)).toBe(true);
  });

  it('signature fails for a tampered message', async () => {
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const msg = createHash('sha256').update('hello').digest();
    const sig = await ed.signAsync(msg, priv);
    const tampered = createHash('sha256').update('helloX').digest();
    expect(await ed.verifyAsync(sig, tampered, pub)).toBe(false);
  });

  it('signature fails when verified with a different public key', async () => {
    const priv1 = ed.utils.randomPrivateKey();
    const priv2 = ed.utils.randomPrivateKey();
    const pub2 = await ed.getPublicKeyAsync(priv2);
    const msg = createHash('sha256').update('hello').digest();
    const sig = await ed.signAsync(msg, priv1);
    expect(await ed.verifyAsync(sig, msg, pub2)).toBe(false);
  });

  it('signature fails when a single byte is flipped', async () => {
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const msg = createHash('sha256').update('hello').digest();
    const sig = await ed.signAsync(msg, priv);
    const tamperedSig = new Uint8Array(sig);
    tamperedSig[0] = (tamperedSig[0] ?? 0) ^ 0x01;
    expect(await ed.verifyAsync(tamperedSig, msg, pub)).toBe(false);
  });
});
