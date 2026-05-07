'use server';

import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { getLogger } from '@/lib/logger';

/**
 * "Mark all read" for the topbar bell. Bumps the per-user cursor to now;
 * the layout query then filters audit events newer than the cursor when
 * computing the dropdown contents. Doesn't touch the audit chain — the
 * events themselves are immutable.
 */
export async function clearNotificationsAction(): Promise<{ ok: boolean }> {
  const session = await getSession();
  if (!session) return { ok: false };
  const now = new Date();
  await prisma.user.update({
    where: { id: session.user.id },
    data: { notificationsClearedAt: now },
  });
  getLogger().info({ userId: session.user.id, route: 'notifications.clear' }, 'notifications cleared');
  revalidatePath('/dashboard', 'layout');
  return { ok: true };
}
