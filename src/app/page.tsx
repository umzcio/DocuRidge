import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * Routes the visitor to the right place. Always redirects, never renders —
 * the auth layout / dashboard handle their own visual identity.
 */
export default async function Home() {
  const bootstrap = await prisma.bootstrapState.findUnique({ where: { id: 1 } });
  if (!bootstrap || !bootstrap.completedAt) redirect('/setup');

  const session = await getSession();
  if (session) redirect('/dashboard');
  redirect('/login');
}
