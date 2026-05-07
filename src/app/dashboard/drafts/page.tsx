import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { EnvelopeListView } from '@/components/dashboard/envelope-list';

export const dynamic = 'force-dynamic';

export default async function DraftsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; sort?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const sp = await searchParams;
  return (
    <EnvelopeListView
      title="Drafts"
      subtitle="Unfinished documents you can pick up where you left off"
      orgId={session.orgId}
      baseStatus={['DRAFT']}
      searchParams={sp}
      lockStatus
    />
  );
}
