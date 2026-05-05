import { z } from 'zod';
import { getEnv } from '../env';

/**
 * Password policy. v1: minimum length only — guidance from NIST SP 800-63B is
 * to prefer length over composition rules. We do reject the obvious banned
 * substrings to catch sloppy choices.
 */

const BANNED_SUBSTRINGS = ['password', 'docuridge', 'acme', 'qwerty', '12345'];

export function passwordSchema() {
  const minLen = getEnv().PASSWORD_MIN_LENGTH;
  return z
    .string()
    .min(minLen, `Password must be at least ${minLen} characters`)
    .max(256, 'Password too long')
    .refine((v) => !BANNED_SUBSTRINGS.some((s) => v.toLowerCase().includes(s)), {
      message: 'Password contains a disallowed common phrase',
    });
}

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(320);

export const nameSchema = z.string().trim().min(1, 'Name is required').max(120);
