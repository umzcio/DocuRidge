import { SignJWT, jwtVerify } from 'jose';
import { getEnv } from '../env';

/**
 * Recipient signing tokens.
 *
 *   - JWS HS256 with JWS_SIGNING_TOKEN_SECRET (distinct from auth/reset secret).
 *   - Bound to envelopeId + recipientId.
 *   - Time-bounded via `exp`.
 *   - Single-use enforced at the DB layer via `Recipient.tokenJti` — once a
 *     `jti` is recorded against the recipient, that token is consumed.
 *   - The token itself is the secret; we DO NOT persist it. We persist
 *     only the `jti` after first valid use, so the audit log can prove the
 *     token was used exactly once.
 */

const ISSUER = 'docuridge';
const AUDIENCE = 'envelope-signing';

export interface SigningTokenClaims {
  envelopeId: string;
  recipientId: string;
  jti: string;
}

export interface MintedSigningToken {
  token: string;
  jti: string;
  expiresAt: Date;
}

function getSecret(): Uint8Array {
  return new TextEncoder().encode(getEnv().JWS_SIGNING_TOKEN_SECRET);
}

export async function mintSigningToken(args: {
  envelopeId: string;
  recipientId: string;
  ttlSeconds?: number;
}): Promise<MintedSigningToken> {
  const ttl = args.ttlSeconds ?? 14 * 24 * 60 * 60; // 14 days
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const token = await new SignJWT({
    envelopeId: args.envelopeId,
    recipientId: args.recipientId,
    jti,
  } satisfies SigningTokenClaims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(expiresAt)
    .sign(getSecret());
  return { token, jti, expiresAt };
}

export async function verifySigningToken(
  token: string,
): Promise<SigningTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (
      typeof payload.envelopeId !== 'string' ||
      typeof payload.recipientId !== 'string' ||
      typeof payload.jti !== 'string'
    ) {
      return null;
    }
    return {
      envelopeId: payload.envelopeId,
      recipientId: payload.recipientId,
      jti: payload.jti,
    };
  } catch {
    return null;
  }
}
