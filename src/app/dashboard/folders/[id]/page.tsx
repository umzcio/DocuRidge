import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { EnvelopeListView } from '@/components/dashboard/envelope-list';

export const dynamic = 'force-dynamic';

export default async function FolderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; status?: string; sort?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const { id } = await params;
  const sp = await searchParams;

  const folder = await prisma.folder.findFirst({
    where: { id, orgId: session.orgId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!folder) notFound();

  return (
    <EnvelopeListView
      title={folder.name}
      subtitle="Documents in this folder"
      orgId={session.orgId}
      folderId={folder.id}
      searchParams={sp}
    />
  );
}
