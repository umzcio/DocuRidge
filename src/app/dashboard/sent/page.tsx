import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { EnvelopeListView } from '@/components/dashboard/envelope-list';

export const dynamic = 'force-dynamic';

export default async function SentPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; sort?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const sp = await searchParams;
  return (
    <EnvelopeListView
      title="Sent"
      subtitle="Documents you've routed for signature"
      orgId={session.orgId}
      baseStatus={['SENT', 'IN_PROGRESS']}
      searchParams={sp}
      lockStatus
    />
  );
}
