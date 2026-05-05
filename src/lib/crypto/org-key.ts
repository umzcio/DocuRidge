import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { prisma } from '../prisma';
import { getEnv } from '../env';
import { childLogger } from '../logger';

// @noble/ed25519 v2 needs SHA-512 wired in for sync usage. Both sync and async
// paths benefit from this; failure to wire it makes signing throw.
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const log = childLogger({ module: 'org-key' });

export interface OrgKeyMaterial {
  keyId: string;             // OrgSigningKey row id
  fingerprint: string;       // sha256 of public key (hex)
  algorithm: 'ed25519';
  privateKey: Uint8Array;    // 32 bytes
  publicKey: Uint8Array;     // 32 bytes
  publicKeyPem: string;      // unwrapped raw — see PEM helpers below
}

export interface OrgKeyVerifier {
  keyId: string;
  fingerprint: string;
  publicKey: Uint8Array;
  publicKeyPem: string;
}

const cache = new Map<string, OrgKeyMaterial>();

/**
 * Get-or-create the org's Ed25519 signing key.
 *
 * On first call for a new org:
 *   - Generates a fresh keypair via @noble/ed25519
 *   - Persists private key to KEYS_DIR/org_<orgId>_ed25519.key with mode 0o600
 *   - Records OrgSigningKey row (publicKey, fingerprint, filename)
 *
 * On subsequent calls: reads the file from disk, derives public key, returns.
 *
 * Cache is per-process. Restart picks up the file from disk again.
 */
export async function getOrCreateOrgKey(orgId: string): Promise<OrgKeyMaterial> {
  const cached = cache.get(orgId);
  if (cached) return cached;

  const env = getEnv();
  if (!existsSync(env.KEYS_DIR)) {
    mkdirSync(env.KEYS_DIR, { recursive: true, mode: 0o700 });
  }

  const existing = await prisma.orgSigningKey.findFirst({
    where: { orgId, revokedAt: null, algorithm: 'ed25519' },
    orderBy: { createdAt: 'desc' },
  });

  if (existing) {
    const path = join(env.KEYS_DIR, existing.keyFilename);
    if (!existsSync(path)) {
      throw new Error(
        `Org signing key file missing on disk: ${existing.keyFilename}. Refusing to silently regenerate — investigate before continuing.`,
      );
    }
    const raw = readFileSync(path);
    if (raw.length !== 32) {
      throw new Error(`Invalid Ed25519 private key length (${raw.length} bytes) at ${path}`);
    }
    const privateKey = new Uint8Array(raw);
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const material: OrgKeyMaterial = {
      keyId: existing.id,
      fingerprint: existing.fingerprint,
      algorithm: 'ed25519',
      privateKey,
      publicKey,
      publicKeyPem: existing.publicKeyPem,
    };
    cache.set(orgId, material);
    return material;
  }

  // Generate new keypair.
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const fingerprint = createHash('sha256').update(publicKey).digest('hex');
  const keyFilename = `org_${orgId}_ed25519.key`;
  const path = join(env.KEYS_DIR, keyFilename);
  writeFileSync(path, Buffer.from(privateKey), { mode: 0o600 });
  chmodSync(path, 0o600);
  const publicKeyPem = wrapPem(Buffer.from(publicKey).toString('base64'));

  const row = await prisma.orgSigningKey.create({
    data: {
      orgId,
      algorithm: 'ed25519',
      publicKeyPem,
      keyFilename,
      fingerprint,
    },
  });

  log.info({ orgId, keyId: row.id, fingerprint }, 'org signing key generated');

  const material: OrgKeyMaterial = {
    keyId: row.id,
    fingerprint,
    algorithm: 'ed25519',
    privateKey,
    publicKey,
    publicKeyPem,
  };
  cache.set(orgId, material);
  return material;
}

/**
 * Sign a hex string (i.e. an event hash) with the org's private key.
 * Returns the signature as a 128-char hex string (Ed25519 produces 64 bytes).
 */
export async function signHex(orgId: string, hexHash: string): Promise<string> {
  const key = await getOrCreateOrgKey(orgId);
  const sig = await ed.signAsync(hexToBytes(hexHash), key.privateKey);
  return Buffer.from(sig).toString('hex');
}

/** Verify a signature using the org's PUBLIC key. Returns false on any error. */
export async function verifyHexSignature(args: {
  publicKey: Uint8Array;
  hexHash: string;
  hexSignature: string;
}): Promise<boolean> {
  try {
    return await ed.verifyAsync(
      hexToBytes(args.hexSignature),
      hexToBytes(args.hexHash),
      args.publicKey,
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the org's verifying material (public key only) without ever touching
 * the private key file. Used by the verify command and by audit-chain
 * verification on the dashboard.
 */
export async function getOrgKeyForVerify(
  orgId: string,
): Promise<OrgKeyVerifier | null> {
  const existing = await prisma.orgSigningKey.findFirst({
    where: { orgId, revokedAt: null, algorithm: 'ed25519' },
    orderBy: { createdAt: 'desc' },
  });
  if (!existing) return null;
  const publicKey = publicKeyFromPem(existing.publicKeyPem);
  return {
    keyId: existing.id,
    fingerprint: existing.fingerprint,
    publicKey,
    publicKeyPem: existing.publicKeyPem,
  };
}

// ─── PEM helpers (raw 32-byte public key wrapped/unwrapped, no DER) ────────
//
// We use a minimal PEM container that holds a base64 of the raw 32-byte
// public key. This is non-standard (real X.509 SubjectPublicKeyInfo wraps
// the bytes in DER), but it's self-describing for our verify command and
// for embedded-in-manifest verification. Production may swap to a real
// X.509 PEM if the key is signed by a CA.

function wrapPem(b64: string): string {
  return `-----BEGIN DOCURIDGE ED25519 PUBLIC KEY-----\n${b64}\n-----END DOCURIDGE ED25519 PUBLIC KEY-----\n`;
}

export function publicKeyFromPem(pem: string): Uint8Array {
  const b64 = pem
    .split('\n')
    .filter((line) => line && !line.includes('-----'))
    .join('')
    .trim();
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== 32) {
    throw new Error(`Invalid Ed25519 public key length: ${buf.length} bytes`);
  }
  return new Uint8Array(buf);
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex string must have even length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}
