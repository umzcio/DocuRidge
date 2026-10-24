import { cookies } from 'next/headers';
import { loadSigningSession, recordAccessCodeUnlock } from '../envelopes/lifecycle';
import { accessCodeCookieName } from '../access-code';
import { verifyAccessCode } from '../access-code-server';
import { clearAccessCodeFailures, reserveAccessCodeAttempt } from '../access-code-lockout';
import { recordEnvelopeEvent } from '../audit/envelope';
import { mintAccessProof, verifyAccessProof } from './access-proof';

/**
 * The one way request-facing code resolves a signing token.
 *
 * `loadSigningSession` checks the token (signature, jti pin, expiry, status,
 * turn) but not the recipient's access code. Every page, route and server
 * action that acts on a signing token must call `loadGatedSigningSession`
 * instead: when the recipient has an access code it also demands a valid
 * unlock proof (see ./access-proof), so skipping the page's client-side gate
 * and calling an action or the document route directly gets nothing.
 * `session-gate.guard.test.ts` fails if anything else imports the ungated
 * loader.
 */

type RawSession = Awaited<ReturnType<typeof loadSigningSession>>;
export type SigningSession = Extract<RawSession, { ok: true }>;
export type SigningSessionFailureReason =
  | Extract<RawSession, { ok: false }>['reason']
  | 'access_code_required';
export type GatedSigningSession = SigningSession | { ok: false; reason: SigningSessionFailureReason };

function bindingFor(session: SigningSession, accessCodeHash: string) {
  return {
    envelopeId: session.envelope.id,
    recipientId: session.recipient.id,
    jti: session.jti,
    accessCodeHash,
  };
}

export async function loadGatedSigningSession(token: string): Promise<GatedSigningSession> {
  const session = await loadSigningSession(token);
  if (!session.ok) return session;
  const hash = session.recipient.accessCodeHash;
  if (!hash) return session;

  const proof = (await cookies()).get(accessCodeCookieName(session.recipient.id))?.value;
  if (await verifyAccessProof(proof, bindingFor(session, hash))) return session;
  return { ok: false, reason: 'access_code_required' };
}

export type UnlockResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_session' | 'wrong_code' | 'locked' };

/**
 * Check an entered access code and, when it matches, set the unlock-proof
 * cookie and record `recipient.access_code_unlocked`. A recipient without a
 * code gets a no-op success, so the response says nothing about whether a
 * code is configured.
 *
 * Brute force is bounded per recipient, whatever the source IP: the attempt
 * is reserved on the recipient row (one conditional UPDATE … RETURNING)
 * BEFORE the constant-time comparison, so a locked recipient gets no
 * comparison at all — not even for the correct code — and a concurrent burst
 * gets at most ACCESS_CODE_MAX_ATTEMPTS. The attempt that trips the lock is
 * recorded as `recipient.access_code_locked` in the envelope's audit chain,
 * which also reaches the sender's activity feed, notification bell and
 * webhooks. No email is sent: that would let a link holder flood the
 * sender's inbox.
 */
export async function unlockSigningSession(args: {
  token: string;
  code: string;
  ipAddress: string;
  userAgent: string;
}): Promise<UnlockResult> {
  const session = await loadSigningSession(args.token);
  if (!session.ok) return { ok: false, reason: 'invalid_session' };
  const hash = session.recipient.accessCodeHash;
  if (!hash) return { ok: true };
  const envelopeId = session.envelope.id;
  const recipientId = session.recipient.id;

  const reservation = await reserveAccessCodeAttempt(recipientId);
  if (!reservation.allowed) return { ok: false, reason: 'locked' };

  if (!verifyAccessCode(hash, args.code)) {
    if (!reservation.lockedUntil) return { ok: false, reason: 'wrong_code' };
    await recordEnvelopeEvent({
      envelopeId,
      type: 'recipient.access_code_locked',
      actorRecipientId: recipientId,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
      data: {
        failedAttempts: reservation.attempts,
        lockouts: reservation.lockouts,
        lockedUntil: reservation.lockedUntil.toISOString(),
      },
    });
    return { ok: false, reason: 'locked' };
  }

  await clearAccessCodeFailures(recipientId);
  const proof = await mintAccessProof(bindingFor(session, hash));
  (await cookies()).set(accessCodeCookieName(recipientId), proof.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: proof.expiresAt,
  });
  await recordAccessCodeUnlock({
    envelopeId,
    recipientId,
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  });
  return { ok: true };
}
