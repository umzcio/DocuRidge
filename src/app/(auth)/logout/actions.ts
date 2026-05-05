'use server';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { revokeSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';

export async function logoutAction(): Promise<never> {
  const cookieStore = await cookies();
  const id = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (id) {
    try { await revokeSession(id); } catch { /* tolerate */ }
  }
  cookieStore.delete(SESSION_COOKIE_NAME);
  redirect('/login');
}
