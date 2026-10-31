import { randomUUID } from 'node:crypto';
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
 *    transaction: it would wait on this lock from another connection. The
 *    wait is bounded (`lockEnvelopeChain`), since it holds a pooled
 *    connection.
 *  - With the lock held, an envelope whose completion has raised its seal
 *    fence (`raiseSealFence`) refuses the append with `EnvelopeSealFencedError`;
 *    `commitWithEnvelopeEvents` then waits for the fence to lift, holding no
 *    connection, and runs the transaction again.
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
  /** The token of a seal fence the caller raised itself: that fence does not refuse this append. */
  ownSealFence?: string,
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

  await lockChainForAppend(tx, args.envelopeId, ownSealFence);

  const prior = await tx.auditEvent.findFirst({
    where: { envelopeId: args.envelopeId },
    orderBy: { seq: 'desc' },
    select: { seq: true, eventHash: true },
  });
  const event = await chainedEvent(orgKey, prior, args);

  await tx.auditEvent.create({ data: eventRowData(event) });

  return { type: args.type, envelopeId: args.envelopeId, orgId: envelope.orgId, data: args.data };
}

/**
 * An audit event computed ahead of the transaction that stores it, shaped
 * like a stored AuditEvent row (nulls, not undefined), so a sealed manifest
 * built from it is identical to one built later from the stored row.
 */
export interface PreparedEnvelopeEvent {
  envelopeId: string;
  seq: number;
  type: EnvelopeEventType;
  actorUserId: string | null;
  actorRecipientId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  data: Record<string, unknown> | null;
  prevHash: string;
  eventHash: string;
  signature: string;
  signedByKeyId: string;
  createdAt: Date;
}

/** Hash and sign `args` as the event after `prior` (null: the first event). */
async function chainedEvent(
  key: OrgKeyMaterial,
  prior: { seq: number; eventHash: string } | null,
  args: RecordEnvelopeEventArgs,
): Promise<Omit<PreparedEnvelopeEvent, 'createdAt'>> {
  const body = {
    envelopeId: args.envelopeId,
    seq: (prior?.seq ?? 0) + 1,
    type: args.type,
    actorUserId: args.actorUserId ?? null,
    actorRecipientId: args.actorRecipientId ?? null,
    actorEmail: args.actorEmail ?? null,
    actorName: args.actorName ?? null,
    ipAddress: args.ipAddress ?? null,
    userAgent: args.userAgent ?? null,
    data: args.data ?? null,
    prevHash: prior?.eventHash ?? GENESIS_PREV_HASH,
  };
  const eventHash = await hashAuditEventBody(body);
  const signature = await signHexWithKey(key, eventHash);
  return { ...body, eventHash, signature, signedByKeyId: key.keyId };
}

function eventRowData(event: Omit<PreparedEnvelopeEvent, 'createdAt'> & { createdAt?: Date }): Prisma.AuditEventUncheckedCreateInput {
  return {
    envelopeId: event.envelopeId,
    seq: event.seq,
    type: event.type,
    actorUserId: event.actorUserId,
    actorRecipientId: event.actorRecipientId,
    actorEmail: event.actorEmail,
    actorName: event.actorName,
    ipAddress: event.ipAddress,
    userAgent: event.userAgent,
    data: event.data ? (event.data as Prisma.InputJsonValue) : Prisma.JsonNull,
    prevHash: event.prevHash,
    eventHash: event.eventHash,
    signature: event.signature,
    signedByKeyId: event.signedByKeyId,
    ...(event.createdAt ? { createdAt: event.createdAt } : {}),
  };
}

/**
 * Compute, hash and sign the event that will follow `prior` in an envelope's
 * chain, without storing it, so a sealed document can include an event
 * (e.g. `envelope.completed`) before the transaction that records it.
 * `insertPreparedEnvelopeEvent` stores exactly this event, and only while
 * `prior` is still the chain head.
 */
export async function prepareEnvelopeEvent(args: {
  key: OrgKeyMaterial;
  prior: { seq: number; eventHash: string } | null;
  createdAt: Date;
  event: RecordEnvelopeEventArgs;
}): Promise<PreparedEnvelopeEvent> {
  return { ...(await chainedEvent(args.key, args.prior, storableEventArgs(args.event))), createdAt: args.createdAt };
}

/**
 * Store a prepared event inside the caller's transaction, under the same
 * per-envelope advisory lock `appendEnvelopeEvent` takes. Returns null, and
 * stores nothing, when the chain head is no longer the event it was prepared
 * after (anything appended since) or it was signed with another key.
 */
export async function insertPreparedEnvelopeEvent(
  tx: Prisma.TransactionClient,
  signer: EnvelopeSigner,
  event: PreparedEnvelopeEvent,
): Promise<AppendedEnvelopeEvent | null> {
  const envelope = await tx.envelope.findUnique({ where: { id: event.envelopeId }, select: { orgId: true } });
  if (!envelope || envelope.orgId !== signer.orgId || event.signedByKeyId !== signer.key.keyId) return null;
  // The completion claim that stores this is the fence's owner: no fence check.
  await lockEnvelopeChain(tx, event.envelopeId);
  const prior = await tx.auditEvent.findFirst({
    where: { envelopeId: event.envelopeId },
    orderBy: { seq: 'desc' },
    select: { seq: true, eventHash: true },
  });
  if ((prior?.seq ?? 0) + 1 !== event.seq || (prior?.eventHash ?? GENESIS_PREV_HASH) !== event.prevHash) return null;
  await tx.auditEvent.create({ data: eventRowData(event) });
  return { type: event.type, envelopeId: event.envelopeId, orgId: envelope.orgId, data: event.data ?? undefined };
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
 *
 * An append refused by a completion's seal fence rolls the transaction back;
 * this waits for the fence to lift (polling, no connection held) and runs
 * `fn` again, so the event lands after `envelope.completed`, as it would have
 * had it waited on the lock. One that timed out on the chain lock is retried
 * twice. Either refusal fails the transaction even if `fn` caught it. `fn`
 * must therefore only write through `tx` (or undo its other effects when the
 * transaction fails), as every caller's does.
 *
 * `options.ownSealFence` is the token of a fence the caller raised itself
 * (completion recording its own failure): that fence does not refuse it.
 */
export async function commitWithEnvelopeEvents<T>(
  envelopeId: string,
  fn: (
    tx: Prisma.TransactionClient,
    record: (args: RecordEnvelopeEventArgs) => Promise<void>,
    /** Store a prepared event; false (nothing stored) when the chain moved on. */
    recordPrepared: (event: PreparedEnvelopeEvent) => Promise<boolean>,
  ) => Promise<T>,
  options: { collect?: AppendedEnvelopeEvent[]; timeoutMs?: number; ownSealFence?: string } = {},
): Promise<T> {
  const signer = await resolveEnvelopeSigner(envelopeId);
  const fenceDeadline = Date.now() + SEAL_FENCE_WAIT_MS;
  for (let busy = 0; ; ) {
    const appended: AppendedEnvelopeEvent[] = [];
    let result: T;
    try {
      // A signing commit appends one event per filled field; leave room beyond
      // Prisma's 5 s interactive-transaction default.
      result = await prisma.$transaction(
        async (tx) => {
          let refused: EnvelopeSealFencedError | EnvelopeChainBusyError | null = null;
          const noteRefusal = (err: unknown) => {
            if (err instanceof EnvelopeSealFencedError || err instanceof EnvelopeChainBusyError) refused ??= err;
          };
          const out = await fn(
            tx,
            async (args) => {
              try {
                appended.push(await appendEnvelopeEvent(tx, signer, args, options.ownSealFence));
              } catch (err) {
                noteRefusal(err);
                throw err;
              }
            },
            async (event) => {
              try {
                const stored = await insertPreparedEnvelopeEvent(tx, signer, event);
                if (stored) appended.push(stored);
                return !!stored;
              } catch (err) {
                noteRefusal(err);
                throw err;
              }
            },
          );
          // Even if `fn` caught it: the event it meant to record is missing
          // (and after a lock timeout the transaction is aborted anyway).
          if (refused) throw refused;
          return out;
        },
        { timeout: options.timeoutMs ?? 15_000 },
      );
    } catch (err) {
      if (err instanceof EnvelopeSealFencedError && Date.now() < fenceDeadline) {
        await sealFenceLifted(err.envelopeId, fenceDeadline);
        continue;
      }
      if (err instanceof EnvelopeChainBusyError && busy < CHAIN_BUSY_RETRIES) {
        busy++;
        await sleep(50 + Math.floor(Math.random() * 200));
        continue;
      }
      throw err;
    }
    if (options.collect) options.collect.push(...appended);
    else await publishEnvelopeEvents(appended);
    return result;
  }
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

/**
 * Longest wait for an envelope's audit-chain lock. A waiting transaction holds
 * a pooled connection, so the wait is bounded: nothing holds the lock for
 * longer than a short commit (seal builds run outside it, behind the seal
 * fence instead), and an append that still times out fails with
 * `EnvelopeChainBusyError` rather than pinning its connection.
 */
export const CHAIN_LOCK_TIMEOUT_MS = 5_000;
/** Reruns of a transaction whose chain lock wait timed out, before giving up. */
const CHAIN_BUSY_RETRIES = 2;

/**
 * The longest lease a seal fence may have (`raiseSealFence`). Completion sizes
 * its lease from the fenced build's limits (lifecycle.ts) and lifts the fence
 * as soon as its claim commits or fails; the lease only runs out if the
 * process dies meanwhile, or the build overruns them.
 */
export const MAX_SEAL_FENCE_MS = 120_000;
/**
 * How long an append waits for seal fences before giving up: above the
 * longest lease, so it outlasts any fence a completion holds.
 */
export const SEAL_FENCE_WAIT_MS = MAX_SEAL_FENCE_MS + 2 * CHAIN_LOCK_TIMEOUT_MS;

/** The envelope's audit chain stayed locked past `CHAIN_LOCK_TIMEOUT_MS`. */
export class EnvelopeChainBusyError extends Error {
  constructor(readonly envelopeId: string) {
    super('This document is busy. Try again in a moment.');
    this.name = 'EnvelopeChainBusyError';
  }
}

/** The envelope's completion holds its seal fence: appends wait until it lifts. */
export class EnvelopeSealFencedError extends Error {
  constructor(readonly envelopeId: string) {
    super('This document is being sealed. Try again in a minute.');
    this.name = 'EnvelopeSealFencedError';
  }
}

/**
 * Hold the envelope's audit-chain lock (the advisory lock every append takes)
 * until the caller's transaction ends: nothing can be appended meanwhile.
 * Callers that also write the envelope row must lock the row first, as the
 * signing and completion commits do, so lock order stays row → chain.
 *
 * The wait is bounded by `CHAIN_LOCK_TIMEOUT_MS` (`lock_timeout`, for the rest
 * of the transaction: one holding the chain must not wait long on anything
 * else either); past it this throws `EnvelopeChainBusyError` and the
 * transaction is aborted.
 */
export async function lockEnvelopeChain(tx: Prisma.TransactionClient, envelopeId: string): Promise<void> {
  const lockKey = await advisoryLockKey(envelopeId);
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${CHAIN_LOCK_TIMEOUT_MS}ms`}, true)`;
  try {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey}::bigint)`;
  } catch (err) {
    if (isLockTimeout(err)) throw new EnvelopeChainBusyError(envelopeId);
    throw err;
  }
}

function isLockTimeout(err: unknown): boolean {
  // Postgres lock_not_available; Prisma reports a failed raw query as P2010
  // with the database's code in `meta.code`.
  const meta = (err as { meta?: { code?: unknown } } | null)?.meta;
  return meta?.code === '55P03' || (err instanceof Error && /\b55P03\b|lock timeout/.test(err.message));
}

/** Transactions that hold an envelope's chain lock and found no seal fence. */
const appendLocked = new WeakMap<object, Set<string>>();

/**
 * Take the chain lock for an append and refuse the append while the
 * envelope's seal fence is up. Once a transaction holds the lock no fence can
 * be raised (raising takes the lock too), so this runs once per transaction
 * and envelope.
 */
async function lockChainForAppend(
  tx: Prisma.TransactionClient,
  envelopeId: string,
  ownSealFence: string | undefined,
): Promise<void> {
  const held = appendLocked.get(tx);
  if (held?.has(envelopeId)) return;
  await lockEnvelopeChain(tx, envelopeId);
  // A statement after the lock: it sees every fence committed before the lock
  // was granted.
  if (await sealFenceUp(tx, envelopeId, ownSealFence)) throw new EnvelopeSealFencedError(envelopeId);
  if (held) held.add(envelopeId);
  else appendLocked.set(tx, new Set([envelopeId]));
}

/**
 * Whether the envelope's seal fence is up: raised, not yet expired, and the
 * envelope still awaiting signatures (a completion that committed has nothing
 * left to fence, whether or not it got to lift it). A fence whose token is
 * `ownSealFence` does not count. The fence is read with SQL because it is no
 * part of the typed envelope rows the app passes around. Times are UTC, as
 * Prisma stores them.
 */
async function sealFenceUp(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  envelopeId: string,
  ownSealFence?: string,
): Promise<boolean> {
  // Tokens are never empty, so '' stands for "no fence of the caller's".
  const rows = await db.$queryRaw<Array<{ up: boolean }>>`
    SELECT ("sealFenceUntil" > (clock_timestamp() AT TIME ZONE 'UTC') AND "status" IN ('SENT', 'IN_PROGRESS')
      AND "sealFenceToken" IS DISTINCT FROM ${ownSealFence ?? ''}) AS "up"
    FROM "envelope" WHERE "id" = ${envelopeId}`;
  return rows[0]?.up === true;
}

/**
 * Raise the envelope's seal fence, while it still awaits signatures: from the
 * commit on, every append to it is refused (and waits, see
 * `commitWithEnvelopeEvents`) until `lowerSealFence` or `leaseMs` (at most
 * `MAX_SEAL_FENCE_MS`) runs out. The chain lock is taken (row first, then
 * chain) only to let appends already holding it commit first, so once this
 * returns the chain head stays put; the lease starts once the lock is
 * granted, so waiting for it does not eat into the lease. Returns the fence's
 * token (random, so one completer can only ever lower its own fence), or null
 * (nothing raised) when the envelope no longer awaits signatures.
 */
export async function raiseSealFence(envelopeId: string, leaseMs: number): Promise<string | null> {
  if (!(leaseMs > 0 && leaseMs <= MAX_SEAL_FENCE_MS)) {
    throw new Error(`A seal fence lease must be between 0 and ${MAX_SEAL_FENCE_MS} ms`);
  }
  for (let busy = 0; ; busy++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const token = randomUUID();
        const claimed = await tx.$executeRaw`
          UPDATE "envelope" SET "sealFenceToken" = ${token}
          WHERE "id" = ${envelopeId} AND "status" IN ('SENT', 'IN_PROGRESS')`;
        if (claimed === 0) return null;
        await lockEnvelopeChain(tx, envelopeId);
        await tx.$executeRaw`
          UPDATE "envelope"
          SET "sealFenceUntil" = (clock_timestamp() AT TIME ZONE 'UTC') + ${`${leaseMs} milliseconds`}::interval
          WHERE "id" = ${envelopeId}`;
        return token;
      }, { timeout: CHAIN_LOCK_TIMEOUT_MS + 5_000 });
    } catch (err) {
      if (err instanceof EnvelopeChainBusyError && busy < CHAIN_BUSY_RETRIES) continue;
      throw err;
    }
  }
}

/** Lift the fence `raiseSealFence` returned `token` for, unless a newer one replaced it. */
export async function lowerSealFence(envelopeId: string, token: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "envelope" SET "sealFenceUntil" = NULL, "sealFenceToken" = NULL
    WHERE "id" = ${envelopeId} AND "sealFenceToken" = ${token}`;
}

/** One poll per envelope however many appends wait on it. */
const fenceWaits = new Map<string, Promise<void>>();

/** Resolve once the envelope's seal fence is down, or at `deadline`. Holds no connection between polls. */
function sealFenceLifted(envelopeId: string, deadline: number): Promise<void> {
  let wait = fenceWaits.get(envelopeId);
  if (!wait) {
    wait = (async () => {
      for (let delay = 25; Date.now() < deadline; delay = Math.min(delay * 2, 500)) {
        await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
        if (!(await sealFenceUp(prisma, envelopeId))) return;
      }
    })().finally(() => fenceWaits.delete(envelopeId));
    fenceWaits.set(envelopeId, wait);
  }
  return wait;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
