import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { EnvelopeListView } from '@/components/dashboard/envelope-list';

export const dynamic = 'force-dynamic';

export default async function AllAgreementsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; sort?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const sp = await searchParams;
  return (
    <EnvelopeListView
      title="All documents"
      subtitle="Every document across your account"
      orgId={session.orgId}
      searchParams={sp}
    />
  );
}
