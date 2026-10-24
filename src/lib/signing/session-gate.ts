import { cookies } from 'next/headers';
import { loadSigningSession, recordAccessCodeUnlock } from '../envelopes/lifecycle';
import { accessCodeCookieName } from '../access-code';
import { verifyAccessCode } from '../access-code-server';
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
  | { ok: false; reason: 'invalid_session' }
  | { ok: false; reason: 'wrong_code'; recipientId: string };

/**
 * Check an entered access code and, when it matches, set the unlock-proof
 * cookie and record `recipient.access_code_unlocked`. A recipient without a
 * code gets a no-op success, so the response says nothing about whether a
 * code is configured.
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

  if (!verifyAccessCode(hash, args.code)) {
    return { ok: false, reason: 'wrong_code', recipientId: session.recipient.id };
  }

  const proof = await mintAccessProof(bindingFor(session, hash));
  (await cookies()).set(accessCodeCookieName(session.recipient.id), proof.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: proof.expiresAt,
  });
  await recordAccessCodeUnlock({
    envelopeId: session.envelope.id,
    recipientId: session.recipient.id,
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  });
  return { ok: true };
}
