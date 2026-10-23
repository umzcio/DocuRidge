'use server';

import { headers } from 'next/headers';
import { after } from 'next/server';
import { z } from 'zod';
import { hashPassword } from '@/lib/auth/argon';
import { completeRegistration } from '@/lib/auth/registration';
import { childLogger } from '@/lib/logger';
import { captureClientContext } from '@/lib/auth/session';
import { checkRateLimit } from '@/lib/ratelimit';
import { emailSchema, nameSchema, passwordSchema } from '@/lib/auth/passwords';

export interface RegisterActionState {
  ok: boolean;
  message?: string;
  error?: string;
  fieldErrors?: { name?: string; email?: string; password?: string; orgName?: string };
}

export async function registerAction(
  _prev: RegisterActionState,
  formData: FormData,
): Promise<RegisterActionState> {
  const log = childLogger({ action: 'register' });
  const headerStore = await headers();
  const { ipAddress, userAgent } = captureClientContext(headerStore);

  const rl = await checkRateLimit(`ip:${ipAddress}`, 'register');
  if (!rl.allowed) {
    return { ok: false, error: 'Too many registration attempts. Try again later.' };
  }

  const InputSchema = z.object({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema(),
    orgName: z.string().trim().min(1, 'Organisation name is required').max(120),
  });

  const parsed = InputSchema.safeParse({
    name: formData.get('name'),
    email: formData.get('email'),
    password: formData.get('password'),
    orgName: formData.get('orgName'),
  });
  if (!parsed.success) {
    return { ok: false, fieldErrors: fieldErrorsFromZod(parsed.error) };
  }
  const { name, email, password, orgName } = parsed.data;

  // Hash for every request, used or not, so new and existing addresses cost
  // the same before the response goes out.
  const passwordHash = await hashPassword(password);
  after(async () => {
    try {
      await completeRegistration({ name, email, passwordHash, orgName, ipAddress, userAgent });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'registration failed');
    }
  });

  return {
    ok: true,
    message:
      'Check your email to finish signing up. If this address already has an account, the email tells you how to sign in.',
  };
}

function fieldErrorsFromZod(err: z.ZodError) {
  const out: RegisterActionState['fieldErrors'] = {};
  for (const issue of err.errors) {
    const key = issue.path[0];
    if (key === 'name' || key === 'email' || key === 'password' || key === 'orgName') {
      out[key as keyof typeof out] = issue.message;
    }
  }
  return out;
}
