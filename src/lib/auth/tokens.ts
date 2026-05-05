import { SignJWT, jwtVerify } from 'jose';
import { getEnv } from '../env';
import { sha256Hex } from '../util';

/**
 * Tokens for password reset and email verification.
 *
 * Two parallel mechanisms for defense in depth:
 *   (1) the token itself is JWS-signed (jose), so even leaked tokens cannot
 *       be forged without the secret;
 *   (2) we store SHA-256(token) in the DB and mark consumedAt on use, so a
 *       leaked token is also single-use.
 *
 * Expiry: enforced both in the JWS exp claim and in the DB row's expiresAt.
 */

type TokenPurpose = 'password_reset' | 'email_verification';

interface TokenClaims {
  userId: string;
  purpose: TokenPurpose;
  jti: string;
}

export interface MintedToken {
  /** The token to send via email — never persist this. */
  token: string;
  /** SHA-256 of the token; this is what goes into the DB. */
  tokenHash: string;
  /** UTC expiry. */
  expiresAt: Date;
}

const ISSUER = 'docuridge';

function getSecret(): Uint8Array {
  return new TextEncoder().encode(getEnv().JWS_RESET_TOKEN_SECRET);
}

export async function mintToken(args: {
  userId: string;
  purpose: TokenPurpose;
  ttlSeconds: number;
}): Promise<MintedToken> {
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + args.ttlSeconds * 1000);

  const token = await new SignJWT({
    userId: args.userId,
    purpose: args.purpose,
    jti,
  } satisfies TokenClaims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(args.purpose)
    .setExpirationTime(expiresAt)
    .sign(getSecret());

  const tokenHash = await sha256Hex(token);
  return { token, tokenHash, expiresAt };
}

export interface VerifiedToken {
  userId: string;
  purpose: TokenPurpose;
  jti: string;
}

export async function verifyToken(
  token: string,
  expectedPurpose: TokenPurpose,
): Promise<VerifiedToken | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: ISSUER,
      audience: expectedPurpose,
    });
    if (
      typeof payload.userId !== 'string' ||
      typeof payload.purpose !== 'string' ||
      typeof payload.jti !== 'string' ||
      payload.purpose !== expectedPurpose
    ) {
      return null;
    }
    return {
      userId: payload.userId,
      purpose: payload.purpose as TokenPurpose,
      jti: payload.jti,
    };
  } catch {
    return null;
  }
}

/** SHA-256 of a token, exposed for symmetric DB lookups by consumers. */
export async function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}
