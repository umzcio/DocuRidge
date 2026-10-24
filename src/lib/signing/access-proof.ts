import { createHash, createHmac } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { getEnv } from '../env';
import { ACCESS_CODE_COOKIE_TTL_SECONDS } from '../access-code';

/**
 * Server-minted proof that the holder entered a recipient's access code.
 *
 * Carried in the `dr_access_<recipientId>` cookie and checked on every
 * token-consuming request by `loadGatedSigningSession`. It is a JWS (HS256)
 * whose key is derived from JWS_SIGNING_TOKEN_SECRET with a fixed label, and
 * whose audience differs from the signing token's, so a signing token can
 * never pass as a proof (or vice versa). It is bound to:
 *   - the envelope and recipient,
 *   - the jti of the signing token pinned on the recipient when the code was
 *     entered, so any re-mint (reassign, reminder, sender resend) voids it,
 *   - a fingerprint of the access-code hash, so a changed code voids it,
 * and it expires (default: ACCESS_CODE_COOKIE_TTL_SECONDS).
 */

const ISSUER = 'docuridge';
const AUDIENCE = 'access-code-proof';
const KEY_LABEL = 'docuridge/access-code-proof/v1';

export interface AccessProofBinding {
  envelopeId: string;
  recipientId: string;
  /** jti of the recipient's current signing token. */
  jti: string;
  accessCodeHash: string;
}

interface ProofClaims {
  env: string;
  rcp: string;
  sjti: string;
  cfp: string;
}

function proofKey(): Uint8Array {
  return new Uint8Array(
    createHmac('sha256', getEnv().JWS_SIGNING_TOKEN_SECRET).update(KEY_LABEL).digest(),
  );
}

/** Never put the stored hash itself in a cookie; a one-way fingerprint is enough to bind it. */
function codeFingerprint(accessCodeHash: string): string {
  return createHash('sha256').update(`${KEY_LABEL}:${accessCodeHash}`).digest('hex').slice(0, 32);
}

export async function mintAccessProof(
  binding: AccessProofBinding,
  ttlSeconds: number = ACCESS_CODE_COOKIE_TTL_SECONDS,
): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const token = await new SignJWT({
    env: binding.envelopeId,
    rcp: binding.recipientId,
    sjti: binding.jti,
    cfp: codeFingerprint(binding.accessCodeHash),
  } satisfies ProofClaims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(expiresAt)
    .sign(proofKey());
  return { token, expiresAt };
}

export async function verifyAccessProof(
  proof: string | undefined | null,
  binding: AccessProofBinding,
): Promise<boolean> {
  if (!proof) return false;
  try {
    const { payload } = await jwtVerify(proof, proofKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    return (
      payload.env === binding.envelopeId &&
      payload.rcp === binding.recipientId &&
      payload.sjti === binding.jti &&
      payload.cfp === codeFingerprint(binding.accessCodeHash)
    );
  } catch {
    return false;
  }
}
