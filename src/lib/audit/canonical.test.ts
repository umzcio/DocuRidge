import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import {
  canonicalJson,
  buildAuditEventBody,
  hashAuditEventBody,
  publicKeyFromPem,
  verifyHexSignature,
  hexToBytes,
  type AuditEventBodyInput,
} from './canonical';

describe('canonicalJson', () => {
  it('sorts keys at the top level', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts keys at every nesting level, including inside arrays of objects', () => {
    const value = {
      z: 1,
      list: [
        { d: 4, c: 3 },
        { b: 2, a: 1 },
      ],
      nested: { y: 2, x: 1 },
    };
    expect(canonicalJson(value)).toBe(
      '{"list":[{"c":3,"d":4},{"a":1,"b":2}],"nested":{"x":1,"y":2},"z":1}',
    );
  });

  it('strips undefined-valued keys', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('preserves explicit null (does not strip it)', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });

  it('handles primitives, null, and empty object/array', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('hi')).toBe('"hi"');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });

  it('produces byte-identical output for two objects built in different key orders', () => {
    const a = { alpha: 1, beta: { y: 2, x: 1 }, gamma: [3, 2, 1] };
    const b = { gamma: [3, 2, 1], alpha: 1, beta: { x: 1, y: 2 } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});

const EXPECTED_BODY_KEYS = [
  'actorEmail',
  'actorName',
  'actorRecipientId',
  'actorUserId',
  'data',
  'envelopeId',
  'ipAddress',
  'prevHash',
  'seq',
  'type',
  'userAgent',
].sort();

function fixedInput(): AuditEventBodyInput {
  return {
    envelopeId: 'env-1',
    seq: 1,
    type: 'envelope.created',
    actorUserId: 'user-1',
    actorRecipientId: 'recipient-1',
    actorEmail: 'a@example.com',
    actorName: 'Alice',
    ipAddress: '10.0.0.1',
    userAgent: 'ua',
    data: { k: 'v' },
    prevHash: '0'.repeat(64),
  };
}

describe('buildAuditEventBody', () => {
  it('has exactly eleven keys', () => {
    expect(Object.keys(buildAuditEventBody(fixedInput())).sort()).toEqual(EXPECTED_BODY_KEYS);
  });

  it('undefined and null inputs for nullable fields both produce null', () => {
    const withUndefined = buildAuditEventBody({
      ...fixedInput(),
      actorUserId: undefined as unknown as null,
      actorRecipientId: undefined as unknown as null,
      actorEmail: undefined as unknown as null,
      actorName: undefined as unknown as null,
      ipAddress: undefined as unknown as null,
      userAgent: undefined as unknown as null,
      data: undefined,
    });
    const withNull = buildAuditEventBody({
      ...fixedInput(),
      actorUserId: null,
      actorRecipientId: null,
      actorEmail: null,
      actorName: null,
      ipAddress: null,
      userAgent: null,
      data: null,
    });
    for (const key of ['actorUserId', 'actorRecipientId', 'actorEmail', 'actorName', 'ipAddress', 'userAgent', 'data']) {
      expect(withUndefined[key]).toBeNull();
      expect(withNull[key]).toBeNull();
    }
  });
});

describe('hashAuditEventBody', () => {
  it('hashes the same logical event identically regardless of construction order', async () => {
    const input = fixedInput();
    const reordered: AuditEventBodyInput = {
      prevHash: input.prevHash,
      data: input.data,
      userAgent: input.userAgent,
      ipAddress: input.ipAddress,
      actorName: input.actorName,
      actorEmail: input.actorEmail,
      actorRecipientId: input.actorRecipientId,
      actorUserId: input.actorUserId,
      type: input.type,
      seq: input.seq,
      envelopeId: input.envelopeId,
    };
    expect(await hashAuditEventBody(input)).toBe(await hashAuditEventBody(reordered));
  });

  it('changes the hash when any single field changes', async () => {
    const base = await hashAuditEventBody(fixedInput());
    const perturbations: Partial<AuditEventBodyInput>[] = [
      { envelopeId: 'env-2' },
      { seq: 2 },
      { type: 'envelope.sealed' },
      { actorUserId: 'user-2' },
      { actorRecipientId: 'recipient-2' },
      { actorEmail: 'b@example.com' },
      { actorName: 'Bob' },
      { ipAddress: '10.0.0.2' },
      { userAgent: 'ua-2' },
      { data: { k: 'w' } },
      { prevHash: '1'.repeat(64) },
    ];
    for (const perturbation of perturbations) {
      const hash = await hashAuditEventBody({ ...fixedInput(), ...perturbation });
      expect(hash).not.toBe(base);
    }
  });

  // Compatibility lock: this literal pins the hash of a fixed, fully-specified
  // event body. If this value ever needs to change, the serializer or body
  // shape changed and every previously sealed PDF will fail verification.
  // Do not update this literal to make a test pass — that means the refactor
  // broke hash compatibility.
  it('pins the digest of a fixed, fully-specified event (compatibility lock)', async () => {
    const input: AuditEventBodyInput = {
      envelopeId: 'env-fixed-0001',
      seq: 7,
      type: 'recipient.signed',
      actorUserId: 'user-aaa',
      actorRecipientId: 'recipient-bbb',
      actorEmail: 'signer@example.com',
      actorName: 'Signer Name',
      ipAddress: '203.0.113.42',
      userAgent: 'Mozilla/5.0 (Fixture)',
      data: { foo: 'bar', nested: { z: 1, a: 2 } },
      prevHash: 'a'.repeat(64),
    };
    const hash = await hashAuditEventBody(input);
    expect(hash).toBe('153b6c802e20cab61b2ab50c074f85eea3b99360c2159ff39acd98b30ee7f866');
  });
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

  it('throws on malformed input', () => {
    expect(() => publicKeyFromPem('not-a-pem')).toThrow();
  });

  it('throws on a wrong-length key', () => {
    const shortB64 = Buffer.from('too-short').toString('base64');
    const pem = `-----BEGIN X-----\n${shortB64}\n-----END X-----`;
    expect(() => publicKeyFromPem(pem)).toThrow();
  });
});

describe('verifyHexSignature', () => {
  it('returns true for a real signature over a hex hash', async () => {
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const hexHash = 'ab'.repeat(32);
    const sig = await ed.signAsync(hexToBytes(hexHash), priv);
    const hexSignature = Buffer.from(sig).toString('hex');
    expect(await verifyHexSignature({ publicKey: pub, hexHash, hexSignature })).toBe(true);
  });

  it('returns false for a tampered hash', async () => {
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const hexHash = 'ab'.repeat(32);
    const sig = await ed.signAsync(hexToBytes(hexHash), priv);
    const hexSignature = Buffer.from(sig).toString('hex');
    const tamperedHash = 'cd'.repeat(32);
    expect(await verifyHexSignature({ publicKey: pub, hexHash: tamperedHash, hexSignature })).toBe(false);
  });

  it('returns false for a wrong public key', async () => {
    const priv1 = ed.utils.randomPrivateKey();
    const priv2 = ed.utils.randomPrivateKey();
    const pub2 = await ed.getPublicKeyAsync(priv2);
    const hexHash = 'ab'.repeat(32);
    const sig = await ed.signAsync(hexToBytes(hexHash), priv1);
    const hexSignature = Buffer.from(sig).toString('hex');
    expect(await verifyHexSignature({ publicKey: pub2, hexHash, hexSignature })).toBe(false);
  });

  it('returns false for a malformed hex signature (must not throw)', async () => {
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    await expect(
      verifyHexSignature({ publicKey: pub, hexHash: 'ab'.repeat(32), hexSignature: 'not-hex!' }),
    ).resolves.toBe(false);
  });
});

describe('hexToBytes', () => {
  it('throws on odd-length input', () => {
    expect(() => hexToBytes('abc')).toThrow();
  });

  it('round-trips a known hex string', () => {
    const hex = '00ff10a5';
    const bytes = hexToBytes(hex);
    expect(Buffer.from(bytes).toString('hex')).toBe(hex);
  });
});
