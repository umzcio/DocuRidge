import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { getEnvelopeForOwner } from '@/lib/envelopes/service';
import { logoutAction } from '@/app/(auth)/logout/actions';
import { VoidEnvelopeButton } from './void-button';
import { SaveAsTemplateButton } from './save-template-button';

export const dynamic = 'force-dynamic';

export default async function EnvelopeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const { id } = await params;
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };

  const env = await getEnvelopeForOwner(ctx, id);
  if (!env) notFound();

  const auditEvents = await prisma.auditEvent.findMany({
    where: { envelopeId: env.id },
    orderBy: { seq: 'asc' },
  });
  const sealed = await prisma.sealedDocument.findUnique({
    where: { envelopeId: env.id },
    include: { documentFile: true },
  });

  const canVoid =
    env.type === 'DOCUMENT' &&
    (env.status === 'DRAFT' || env.status === 'SENT' || env.status === 'IN_PROGRESS');
  const canSaveTemplate = env.type === 'DOCUMENT' && (env.status === 'COMPLETED' || env.status === 'IN_PROGRESS' || env.status === 'SENT');

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <nav className="mb-6 flex items-center justify-between text-sm">
        <Link href="/dashboard" className="text-neutral-600 hover:underline">
          ← Back to dashboard
        </Link>
        <form action={logoutAction}>
          <button type="submit" className="text-neutral-600 hover:underline">Sign out</button>
        </form>
      </nav>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{env.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-neutral-600">
            <StatusBadge status={env.status} />
            <span>{env.recipients.length} recipient{env.recipients.length === 1 ? '' : 's'}</span>
            <span>routing: {env.routingMode.toLowerCase()}</span>
            <span>created {new Date(env.createdAt).toLocaleString()}</span>
          </div>
          {env.voidReason && (
            <p className="mt-2 text-sm text-red-800">
              Voided: <span className="italic">{env.voidReason}</span>
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          {canVoid && <VoidEnvelopeButton envelopeId={env.id} />}
          {canSaveTemplate && <SaveAsTemplateButton envelopeId={env.id} suggestedTitle={`${env.title} template`} />}
        </div>
      </div>

      {sealed && (
        <div className="mt-6 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm">
          <p className="font-medium text-emerald-900">Sealed and complete.</p>
          <p className="mt-1 text-emerald-800">
            Document hash: <code className="text-xs">{sealed.documentFile.sha256}</code>
          </p>
          <Link
            href={`/dashboard/envelopes/${env.id}/sealed`}
            className="mt-2 inline-block text-emerald-900 underline"
          >
            Download sealed PDF
          </Link>
          <span className="mx-2 text-emerald-700">·</span>
          <Link
            href={`/dashboard/envelopes/${env.id}/audit.json`}
            className="text-emerald-900 underline"
          >
            Download audit trail (JSON)
          </Link>
        </div>
      )}

      <section className="mt-8">
        <h2 className="text-base font-semibold">Recipients (in signing order)</h2>
        <ol className="mt-2 divide-y divide-neutral-200 rounded-md border border-neutral-200">
          {env.recipients.map((r, idx) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-neutral-100 text-xs font-semibold text-neutral-700">
                  {idx + 1}
                </span>
                <div>
                  <div className="font-medium">{r.name}</div>
                  <div className="text-neutral-500 text-xs">{r.email}</div>
                </div>
              </div>
              <div className="text-right text-xs">
                <div>{r.signingStatus}{r.declineReason ? ' — ' + r.declineReason : ''}</div>
                {r.signedAt && <div className="text-neutral-500">{new Date(r.signedAt).toLocaleString()}</div>}
                {r.declinedAt && <div className="text-red-700">declined {new Date(r.declinedAt).toLocaleString()}</div>}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-8">
        <h2 className="text-base font-semibold">Audit timeline</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Every state change in this envelope, hash-chained. Cryptographic signing arrives in Phase 4.
        </p>
        <ol className="mt-2 space-y-1 text-xs font-mono">
          {auditEvents.map((e) => (
            <li key={e.id} className="rounded-md border border-neutral-200 bg-white px-3 py-1.5">
              <span className="text-neutral-500">#{e.seq}</span>{' '}
              <span className="text-neutral-500">{new Date(e.createdAt).toISOString()}</span>{' '}
              <span className="font-semibold">{e.type}</span>
              {e.actorEmail && <> · {e.actorEmail}</>}
            </li>
          ))}
        </ol>
        {!sealed && (
          <Link
            href={`/dashboard/envelopes/${env.id}/audit.json`}
            className="mt-3 inline-block text-xs text-accent-700 underline"
          >
            Download audit trail (JSON)
          </Link>
        )}
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const classes: Record<string, string> = {
    DRAFT: 'bg-neutral-100 text-neutral-800',
    SENT: 'bg-blue-100 text-blue-900',
    IN_PROGRESS: 'bg-amber-100 text-amber-900',
    COMPLETED: 'bg-emerald-100 text-emerald-900',
    DECLINED: 'bg-red-100 text-red-900',
    VOIDED: 'bg-red-100 text-red-900',
    EXPIRED: 'bg-red-100 text-red-900',
  };
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${classes[status] ?? 'bg-neutral-100'}`}>
      {status.replace('_', ' ')}
    </span>
  );
}
