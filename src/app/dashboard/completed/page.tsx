import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { EnvelopeListView } from '@/components/dashboard/envelope-list';

export const dynamic = 'force-dynamic';

export default async function CompletedPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; sort?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const sp = await searchParams;
  return (
    <EnvelopeListView
      title="Completed"
      subtitle="Fully signed and sealed documents"
      orgId={session.orgId}
      baseStatus={['COMPLETED']}
      searchParams={sp}
      lockStatus
    />
  );
}
