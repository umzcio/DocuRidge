import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { BulkLauncherForm } from './launcher';

export const dynamic = 'force-dynamic';

export default async function BulkSendLauncherPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const { id } = await params;
  const tpl = await prisma.envelope.findFirst({
    where: { id, orgId: session.orgId, deletedAt: null, type: 'TEMPLATE' },
    include: { recipients: { orderBy: { signingOrder: 'asc' } } },
  });
  if (!tpl) notFound();
  const signers = tpl.recipients.filter(
    (r) => r.recipientRole === 'SIGNER' || r.recipientRole === 'WITNESS' || r.recipientRole === 'IN_PERSON_SIGNER',
  );

  return (
    <main className="px-6 lg:px-8 py-8 lg:py-10 max-w-[760px] mx-auto">
      <Link
        href={`/dashboard/templates`}
        className="text-[12.5px] text-ink-tertiary hover:text-ink"
      >
        ← Templates
      </Link>
      <h1 className="mt-3 text-[24px] font-semibold tracking-[-0.018em] text-ink leading-tight">
        Bulk send
      </h1>
      <p className="mt-1 text-[14px] text-ink-secondary">
        Upload a CSV to send <span className="font-medium text-ink">{tpl.title}</span> to many people at once. Each row creates a separate envelope addressed to that recipient.
      </p>

      {signers.length !== 1 && (
        <div className="mt-6 rounded-md border border-status-declined-border bg-status-declined-bg/40 p-4 text-[13px] text-status-declined">
          Bulk send v1 requires templates with exactly one signing recipient. This template has {signers.length}.
        </div>
      )}

      {signers.length === 1 && (
        <>
          <div className="mt-6 rounded-md border border-hairline bg-surface p-4 text-[12.5px] text-ink-secondary leading-relaxed">
            <p className="font-medium text-ink mb-2">CSV format</p>
            <p>
              The first row must be a header. Required columns: <code className="font-mono text-[12px]">name</code>, <code className="font-mono text-[12px]">email</code>. Up to 200 rows per upload. Example:
            </p>
            <pre className="mt-3 rounded bg-surface-muted/40 border border-hairline p-3 font-mono text-[11.5px] text-ink overflow-x-auto">{`name,email
Maria Garcia,maria@example.com
Tom Robinson,tom@example.com`}</pre>
            <p className="mt-3 text-[11.5px] text-ink-tertiary">
              Each row becomes a new envelope from this template; the signing recipient is set to the row's name + email.
              Allowlist gating still applies — non-allowlisted addresses are recorded as Skipped.
            </p>
          </div>

          <BulkLauncherForm templateId={tpl.id} />
        </>
      )}
    </main>
  );
}
