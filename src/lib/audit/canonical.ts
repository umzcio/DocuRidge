import { createHash } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// @noble/ed25519 v2 needs SHA-512 wired in for sync usage. Both sync and async
// paths benefit from this; failure to wire it makes signing throw.
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

/**
 * Genesis `prevHash` for the first event in an envelope's audit chain.
 */
export const GENESIS_PREV_HASH = '0'.repeat(64);

/**
 * Canonical JSON serializer: keys sorted alphabetically at every nesting level,
 * `undefined` values stripped so spread-with-explicit-undefined keys don't
 * show up. Required so the SAME logical event/manifest always produces the
 * same hash regardless of how it was constructed.
 *
 * This is the single implementation, shared by the app and the standalone
 * verifier — changing it changes the hash of every existing sealed PDF.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(',')}}`;
}

export async function sha256Hex(input: string): Promise<string> {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export interface AuditEventBodyInput {
  envelopeId: string;
  seq: number;
  type: string;
  actorUserId: string | null;
  actorRecipientId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  data: unknown;
  prevHash: string;
}

export function buildAuditEventBody(input: AuditEventBodyInput): Record<string, unknown> {
  return {
    envelopeId: input.envelopeId,
    seq: input.seq,
    type: input.type,
    actorUserId: input.actorUserId ?? null,
    actorRecipientId: input.actorRecipientId ?? null,
    actorEmail: input.actorEmail ?? null,
    actorName: input.actorName ?? null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    data: input.data ?? null,
    prevHash: input.prevHash,
  };
}

export async function hashAuditEventBody(input: AuditEventBodyInput): Promise<string> {
  return sha256Hex(canonicalJson(buildAuditEventBody(input)));
}

export function publicKeyFromPem(pem: string): Uint8Array {
  const b64 = pem
    .split('\n')
    .filter((line) => line && !line.includes('-----'))
    .join('')
    .trim();
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== 32) {
    throw new Error(`Invalid Ed25519 public key length: ${buf.length}`);
  }
  return new Uint8Array(buf);
}

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

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex string must have even length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
