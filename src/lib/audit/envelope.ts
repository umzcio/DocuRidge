import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import {
  getOrCreateOrgKey,
  getOrgKeyForVerify,
  signHexWithKey,
  type OrgKeyMaterial,
} from '../crypto/org-key';
import { toStorableJson, toStorableText } from '../storable-text';
import {
  GENESIS_PREV_HASH,
  hashAuditEventBody,
  sha256Hex,
  verifyHexSignature,
} from './canonical';

export { canonicalJson } from './canonical';

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
  | 'recipient.access_code_unlocked'
  | 'recipient.access_code_locked'
  | 'recipient.field_filled'
  | 'recipient.signed'
  | 'recipient.declined'
  | 'recipient.skipped_by_condition'
  | 'envelope.cloned'
  | 'envelope.deleted'
  | 'envelope.forwarded'
  | 'envelope.share_viewed'
  | 'recipient.reassigned'
  | 'comment.added'
  | 'envelope.advanced'
  | 'envelope.corrected'
  | 'envelope.completed'
  | 'envelope.voided_by_sender'
  | 'envelope.expired'
  | 'envelope.sealed'
  | 'envelope.seal_failed'
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

export interface AppendedEnvelopeEvent {
  type: EnvelopeEventType;
  envelopeId: string;
  orgId: string;
  data?: Record<string, unknown>;
}

/**
 * Append an event to the envelope's audit chain inside the caller's
 * transaction, so a state change and the event recording it commit or roll
 * back together.
 *
 * Implementation notes:
 *  - `pg_advisory_xact_lock` keyed on the envelope id serializes event writes
 *    for a single envelope until the caller's transaction ends. Never call
 *    `recordEnvelopeEvent` for the same envelope from inside that
 *    transaction: it would wait on this lock from another connection.
 *  - Computes prevHash from the latest existing event by `seq`.
 *  - eventHash is SHA-256 of canonical JSON of the event body + prevHash.
 *  - Every string is made storable first (see storable-text.ts) so input text
 *    can never make the insert fail, and the hash covers exactly what is
 *    stored.
 *  - Webhooks are not dispatched here; pass the result to
 *    `publishEnvelopeEvents` once the transaction has committed.
 *  - `signer` is resolved by `resolveEnvelopeSigner` BEFORE the transaction
 *    opens, so nothing here queries outside `tx`: a key lookup on the global
 *    client would take a second pool connection while this one holds the
 *    advisory lock, and a key row created there would not roll back.
 */
export async function appendEnvelopeEvent(
  tx: Prisma.TransactionClient,
  signer: EnvelopeSigner,
  rawArgs: RecordEnvelopeEventArgs,
): Promise<AppendedEnvelopeEvent> {
  const args = storableEventArgs(rawArgs);
  const envelope = await tx.envelope.findUnique({
    where: { id: args.envelopeId },
    select: { orgId: true },
  });
  if (!envelope) {
    throw new Error(`Cannot record audit event: envelope ${args.envelopeId} not found`);
  }
  if (envelope.orgId !== signer.orgId) {
    throw new Error(
      `Cannot record audit event: envelope ${args.envelopeId} belongs to a different org than the transaction's signing key`,
    );
  }
  const orgKey = signer.key;

  const lockKey = await advisoryLockKey(args.envelopeId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`;

  const prior = await tx.auditEvent.findFirst({
    where: { envelopeId: args.envelopeId },
    orderBy: { seq: 'desc' },
    select: { seq: true, eventHash: true },
  });
  const seq = (prior?.seq ?? 0) + 1;
  const prevHash = prior?.eventHash ?? GENESIS_PREV_HASH;

  const eventHash = await hashAuditEventBody({
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
  });
  const signature = await signHexWithKey(orgKey, eventHash);

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

  return { type: args.type, envelopeId: args.envelopeId, orgId: envelope.orgId, data: args.data };
}

/**
 * Fire-and-forget outbound webhook delivery for committed audit events. The
 * dispatcher returns immediately; HTTP round-trips happen in the background
 * so the caller's request isn't slowed down.
 */
export async function publishEnvelopeEvents(events: AppendedEnvelopeEvent[]): Promise<void> {
  if (events.length === 0) return;
  const { dispatchWebhooks } = await import('../webhooks/dispatch');
  for (const e of events) {
    dispatchWebhooks({
      type: e.type,
      envelopeId: e.envelopeId,
      orgId: e.orgId,
      occurredAt: new Date(),
      data: e.data ?? undefined,
    });
  }
}

export interface EnvelopeSigner {
  orgId: string;
  key: OrgKeyMaterial;
}

/**
 * Resolve (creating on first use) the signing key of the envelope's org.
 * Runs on the global client and must be called before the audit transaction
 * opens; see `appendEnvelopeEvent`.
 */
export async function resolveEnvelopeSigner(envelopeId: string): Promise<EnvelopeSigner> {
  const envelope = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    select: { orgId: true },
  });
  if (!envelope) {
    throw new Error(`Cannot record audit event: envelope ${envelopeId} not found`);
  }
  return { orgId: envelope.orgId, key: await getOrCreateOrgKey(envelope.orgId) };
}

/**
 * Run `fn` in one transaction together with the audit events it records for
 * `envelopeId` (or other envelopes of the same org), then publish those
 * events' webhooks after the commit. The org's signing key is resolved
 * before the transaction opens.
 *
 * With `options.collect`, the committed events are appended to that array
 * instead of being published, so a caller running several steps can publish
 * them together once the last step is done (see `publishEnvelopeEvents`).
 */
export async function commitWithEnvelopeEvents<T>(
  envelopeId: string,
  fn: (
    tx: Prisma.TransactionClient,
    record: (args: RecordEnvelopeEventArgs) => Promise<void>,
  ) => Promise<T>,
  options: { collect?: AppendedEnvelopeEvent[] } = {},
): Promise<T> {
  const signer = await resolveEnvelopeSigner(envelopeId);
  const appended: AppendedEnvelopeEvent[] = [];
  // A signing commit appends one event per filled field; leave room beyond
  // Prisma's 5 s interactive-transaction default.
  const result = await prisma.$transaction(
    (tx) =>
      fn(tx, async (args) => {
        appended.push(await appendEnvelopeEvent(tx, signer, args));
      }),
    { timeout: 15_000 },
  );
  if (options.collect) options.collect.push(...appended);
  else await publishEnvelopeEvents(appended);
  return result;
}

/** Append a single event in its own transaction. */
export async function recordEnvelopeEvent(
  args: RecordEnvelopeEventArgs,
): Promise<void> {
  await commitWithEnvelopeEvents(args.envelopeId, (_tx, record) => record(args));
}

function storableEventArgs(args: RecordEnvelopeEventArgs): RecordEnvelopeEventArgs {
  const text = (v: string | null | undefined) => (typeof v === 'string' ? toStorableText(v) : v);
  return {
    ...args,
    actorEmail: text(args.actorEmail),
    actorName: text(args.actorName),
    ipAddress: text(args.ipAddress),
    userAgent: text(args.userAgent),
    data: args.data ? (toStorableJson(args.data) as Record<string, unknown>) : args.data,
  };
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
    const expectedHash = await hashAuditEventBody({
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
    });
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
    const expectedHash = await hashAuditEventBody({
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
    });
    if (expectedHash !== e.eventHash) {
      return { ok: false, brokenAtSeq: e.seq, reason: 'eventHash mismatch (no key registered)' };
    }
    prev = e.eventHash;
  }
  return { ok: true };
}
