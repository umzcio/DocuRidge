import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { Sidebar } from '@/components/dashboard/sidebar';
import { TopBar } from '@/components/dashboard/topbar';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect('/login');

  // Pull the user's avatar (small base64 inline blob) so the sidebar chip can show it.
  const userRow = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { avatarBase64: true, avatarMimeType: true, notificationsClearedAt: true },
  });
  const avatarSrc = userRow?.avatarBase64 && userRow.avatarMimeType
    ? `data:${userRow.avatarMimeType};base64,${userRow.avatarBase64}`
    : null;

  // Counts power the sidebar nav badges (org-scoped, document-type only).
  const where = { orgId: session.orgId, deletedAt: null, type: 'DOCUMENT' as const };
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // Notifications floor: newer of (24h ago, the user's last "Clear" cursor).
  const notifSince = userRow?.notificationsClearedAt && userRow.notificationsClearedAt > since24h
    ? userRow.notificationsClearedAt
    : since24h;
  const [grouped, inboxCount, recentEvents, folders] = await Promise.all([
    prisma.envelope.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    }),
    prisma.recipient.count({
      where: {
        email: session.user.email.toLowerCase(),
        signingStatus: 'NOT_SIGNED',
        envelope: {
          orgId: session.orgId,
          deletedAt: null,
          type: 'DOCUMENT',
          status: { in: ['SENT', 'IN_PROGRESS'] },
        },
      },
    }).catch(() => 0),
    // Notifications feed: events on envelopes the current user created OR is a recipient of, last 24h
    prisma.auditEvent.findMany({
      where: {
        createdAt: { gt: notifSince },
        envelope: {
          orgId: session.orgId,
          deletedAt: null,
          type: 'DOCUMENT',
          OR: [
            { createdById: session.user.id },
            { recipients: { some: { email: session.user.email.toLowerCase() } } },
          ],
        },
        type: { in: ['recipient.signed', 'recipient.declined', 'envelope.completed', 'envelope.sent', 'email.failed'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 6,
      include: { envelope: { select: { id: true, title: true } } },
    }).catch(() => []),
    // Sidebar folders: org-scoped, top-level only (parentId null) for v1.
    // Each carries its envelope count for the badge.
    prisma.folder.findMany({
      where: { orgId: session.orgId, deletedAt: null, type: 'DOCUMENT', parentId: null },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        _count: { select: { envelopes: { where: { deletedAt: null } } } },
      },
    }).catch(() => []),
  ]);

  // Resolve actor names for the notifications dropdown so we don't show
  // "System" for every event a user actually triggered.
  const notifActorIds = Array.from(
    new Set(recentEvents.map((e) => e.actorUserId).filter((v): v is string => !!v)),
  );
  const notifActorUsers = notifActorIds.length
    ? await prisma.user.findMany({ where: { id: { in: notifActorIds } }, select: { id: true, name: true } })
    : [];
  const notifActorMap = new Map(notifActorUsers.map((u) => [u.id, u.name]));

  const byStatus = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const total = grouped.reduce((acc, g) => acc + g._count._all, 0);
  const counts = {
    total,
    inbox: inboxCount,
    sent: byStatus('SENT') + byStatus('IN_PROGRESS'),
    drafts: byStatus('DRAFT'),
    completed: byStatus('COMPLETED'),
  };

  return (
    <div className="flex min-h-screen bg-page">
      <Sidebar
        counts={counts}
        folders={folders.map((f) => ({ id: f.id, name: f.name, count: f._count.envelopes }))}
        user={{ name: session.user.name, email: session.user.email, role: session.role, avatarSrc }}
      />
      <div className="flex flex-1 min-w-0 flex-col">
        <TopBar
          notifications={recentEvents.map((e) => ({
            id: e.id,
            type: e.type,
            envelopeId: e.envelopeId,
            envelopeTitle: e.envelope?.title ?? 'document',
            actorName: e.actorName ?? (e.actorUserId ? notifActorMap.get(e.actorUserId) ?? null : null),
            createdAt: e.createdAt.toISOString(),
          }))}
        />
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  );
}
