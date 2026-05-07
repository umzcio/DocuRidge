import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { EnvelopeListView } from '@/components/dashboard/envelope-list';

export const dynamic = 'force-dynamic';

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; sort?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const sp = await searchParams;
  return (
    <EnvelopeListView
      title="Inbox"
      subtitle="Documents waiting for your action"
      orgId={session.orgId}
      baseStatus={['SENT', 'IN_PROGRESS']}
      filterByUserEmail={session.user.email}
      searchParams={sp}
      lockStatus
      showSignNow
    />
  );
}
