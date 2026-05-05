import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { sha256Hex } from '../util';
import { getOrCreateOrgKey, getOrgKeyForVerify, signHex, verifyHexSignature } from '../crypto/org-key';

/**
 * Envelope audit chain — Phase 2 writes plain rows; Phase 4 turns on
 * cryptographic signing of each event.
 *
 * Every envelope event:
 *   - has a monotonic `seq` per envelope (advisory lock to avoid races)
 *   - carries `prevHash` = previous event's `eventHash` (genesis = 64 zeros)
 *   - has `eventHash` = SHA-256 of the canonical-JSON event body including prevHash
 *   - has `signature` = '' for now; Phase 4 sets to Ed25519(eventHash)
 *
 * The chain is verifiable already even without signatures: tampering with
 * any event breaks the hash chain.
 */

const GENESIS_PREV_HASH = '0'.repeat(64);

export type EnvelopeEventType =
  | 'envelope.created'
  | 'envelope.field_added'
  | 'envelope.field_removed'
  | 'envelope.field_updated'
  | 'envelope.recipient_added'
  | 'envelope.recipient_removed'
  | 'envelope.recipient_updated'
  | 'envelope.sent'
  | 'envelope.viewed_by_sender'
  | 'email.sent'
  | 'email.failed'
  | 'recipient.opened'
  | 'recipient.consent_given'
  | 'recipient.field_filled'
  | 'recipient.signed'
  | 'recipient.declined'
  | 'envelope.advanced'
  | 'envelope.completed'
  | 'envelope.voided_by_sender'
  | 'envelope.expired'
  | 'envelope.sealed'
  | 'envelope.downloaded'
  | 'envelope.verified';

export interface RecordEnvelopeEventArgs {
  envelopeId: string;
  type: EnvelopeEventType;
  actorUserId?: string | null;
  actorRecipientId?: string | null;
  actorEmail?: string | null;
  actorName?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  data?: Record<string, unknown>;
}

/**
 * Append an event to the envelope's audit chain.
 *
 * Implementation notes:
 *  - Uses a transaction with `pg_advisory_xact_lock` keyed on the envelope id
 *    to serialize event writes for a single envelope. Multi-envelope
 *    parallelism is unaffected.
 *  - Computes prevHash from the latest existing event by `seq`.
 *  - eventHash is SHA-256 of canonical JSON of the event body + prevHash.
 *  - signature/signedByKeyId left blank in Phase 2; Phase 4 fills them.
 */
export async function recordEnvelopeEvent(
  args: RecordEnvelopeEventArgs,
): Promise<void> {
  // Resolve the org for this envelope so we can sign with the org's key.
  const envelope = await prisma.envelope.findUnique({
    where: { id: args.envelopeId },
    select: { orgId: true },
  });
  if (!envelope) {
    throw new Error(`Cannot record audit event: envelope ${args.envelopeId} not found`);
  }
  const orgKey = await getOrCreateOrgKey(envelope.orgId);

  const lockKey = await advisoryLockKey(args.envelopeId);

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`;

    const prior = await tx.auditEvent.findFirst({
      where: { envelopeId: args.envelopeId },
      orderBy: { seq: 'desc' },
      select: { seq: true, eventHash: true },
    });
    const seq = (prior?.seq ?? 0) + 1;
    const prevHash = prior?.eventHash ?? GENESIS_PREV_HASH;

    const body = {
      envelopeId: args.envelopeId,
      seq,
      type: args.type,
      actorUserId: args.actorUserId ?? null,
      actorRecipientId: args.actorRecipientId ?? null,
      actorEmail: args.actorEmail ?? null,
      actorName: args.actorName ?? null,
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
      data: args.data ?? null,
      prevHash,
    };
    const eventHash = await sha256Hex(canonicalJson(body));
    const signature = await signHex(envelope.orgId, eventHash);

    await tx.auditEvent.create({
      data: {
        envelopeId: args.envelopeId,
        seq,
        type: args.type,
        actorUserId: args.actorUserId ?? null,
        actorRecipientId: args.actorRecipientId ?? null,
        actorEmail: args.actorEmail ?? null,
        actorName: args.actorName ?? null,
        ipAddress: args.ipAddress ?? null,
        userAgent: args.userAgent ?? null,
        data: args.data
          ? (args.data as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        prevHash,
        eventHash,
        signature,
        signedByKeyId: orgKey.keyId,
      },
    });
  });
}

/**
 * Canonical JSON serializer: keys sorted alphabetically at every nesting level,
 * `undefined` values stripped so spread-with-explicit-undefined keys don't
 * show up. Required so the SAME logical event/manifest always produces the
 * same hash regardless of how it was constructed.
 *
 * MUST stay in lockstep with the `canonicalJson` in scripts/verify.ts —
 * any change to one requires a change to the other.
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

async function advisoryLockKey(s: string): Promise<bigint> {
  const hex = (await sha256Hex(s)).slice(0, 16);
  // Convert first 64 bits of hash to a signed 64-bit int.
  return BigInt(`0x${hex}`) - (1n << 63n);
}

/**
 * Verify the chain end-to-end for a single envelope. Returns true iff every
 * event's eventHash matches its body and prevHash, AND the chain is unbroken
 * by sequential prevHash references. Phase 4 also checks signatures.
 */
export async function verifyEnvelopeChain(envelopeId: string): Promise<{
  ok: boolean;
  brokenAtSeq?: number;
  reason?: string;
}> {
  const envelope = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    select: { orgId: true },
  });
  if (!envelope) return { ok: false, reason: 'envelope not found' };

  const verifier = await getOrgKeyForVerify(envelope.orgId);
  if (!verifier) {
    // No key registered yet — chain integrity can still be verified, just no
    // signature check. Surface a softer status.
    return verifyChainHashesOnly(envelopeId);
  }

  const events = await prisma.auditEvent.findMany({
    where: { envelopeId },
    orderBy: { seq: 'asc' },
  });
  let prev = GENESIS_PREV_HASH;
  for (const e of events) {
    if (e.prevHash !== prev) {
      return { ok: false, brokenAtSeq: e.seq, reason: 'prevHash mismatch' };
    }
    const body = {
      envelopeId: e.envelopeId,
      seq: e.seq,
      type: e.type,
      actorUserId: e.actorUserId,
      actorRecipientId: e.actorRecipientId,
      actorEmail: e.actorEmail,
      actorName: e.actorName,
      ipAddress: e.ipAddress,
      userAgent: e.userAgent,
      data: e.data ?? null,
      prevHash: e.prevHash,
    };
    const expectedHash = await sha256Hex(canonicalJson(body));
    if (expectedHash !== e.eventHash) {
      return { ok: false, brokenAtSeq: e.seq, reason: 'eventHash mismatch' };
    }
    if (e.signature) {
      const sigOk = await verifyHexSignature({
        publicKey: verifier.publicKey,
        hexHash: e.eventHash,
        hexSignature: e.signature,
      });
      if (!sigOk) {
        return { ok: false, brokenAtSeq: e.seq, reason: 'event signature invalid' };
      }
    } else {
      return { ok: false, brokenAtSeq: e.seq, reason: 'event signature missing' };
    }
    prev = e.eventHash;
  }
  return { ok: true };
}

async function verifyChainHashesOnly(envelopeId: string): Promise<{
  ok: boolean;
  brokenAtSeq?: number;
  reason?: string;
}> {
  const events = await prisma.auditEvent.findMany({
    where: { envelopeId },
    orderBy: { seq: 'asc' },
  });
  let prev = GENESIS_PREV_HASH;
  for (const e of events) {
    if (e.prevHash !== prev) {
      return { ok: false, brokenAtSeq: e.seq, reason: 'prevHash mismatch (no key registered)' };
    }
    const body = {
      envelopeId: e.envelopeId,
      seq: e.seq,
      type: e.type,
      actorUserId: e.actorUserId,
      actorRecipientId: e.actorRecipientId,
      actorEmail: e.actorEmail,
      actorName: e.actorName,
      ipAddress: e.ipAddress,
      userAgent: e.userAgent,
      data: e.data ?? null,
      prevHash: e.prevHash,
    };
    const expectedHash = await sha256Hex(canonicalJson(body));
    if (expectedHash !== e.eventHash) {
      return { ok: false, brokenAtSeq: e.seq, reason: 'eventHash mismatch (no key registered)' };
    }
    prev = e.eventHash;
  }
  return { ok: true };
}
