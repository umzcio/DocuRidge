import argon2 from 'argon2';

/**
 * Argon2id parameters. Tuned for a baseline that completes in ~150ms on a
 * modern server CPU. Production deployments can tune via env later.
 *
 * memoryCost is in KiB. 64MB is OWASP's current minimum recommendation for
 * interactive logins.
 */
const OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

/**
 * Verify a password. Returns false on any error (malformed hash, mismatch);
 * never throws. Constant-time within argon2.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain, OPTIONS);
  } catch {
    return false;
  }
}
