import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { getEnvelopeForOwner } from '@/lib/envelopes/service';
import { logoutAction } from '@/app/(auth)/logout/actions';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/badge';
import { SectionLabel } from '@/components/ui/section-label';
import { Card, CardBody } from '@/components/ui/card';
import { Banner } from '@/components/ui/banner';
import { Avatar } from '@/components/ui/avatar';
import { VoidEnvelopeButton } from './void-button';
import { SaveAsTemplateButton } from './save-template-button';

export const dynamic = 'force-dynamic';

function relativeTime(date: Date): string {
  const ms = Date.now() - date.getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

const eventLabel: Record<string, string> = {
  'envelope.created': 'Envelope created',
  'envelope.field_added': 'Field placed',
  'envelope.field_removed': 'Field removed',
  'envelope.field_updated': 'Field updated',
  'envelope.recipient_added': 'Recipient added',
  'envelope.recipient_removed': 'Recipient removed',
  'envelope.recipient_updated': 'Recipient updated',
  'envelope.sent': 'Envelope sent',
  'envelope.viewed_by_sender': 'Viewed by sender',
  'envelope.advanced': 'Advanced to next signer',
  'envelope.completed': 'Envelope completed',
  'envelope.voided_by_sender': 'Voided by sender',
  'envelope.expired': 'Envelope expired',
  'envelope.sealed': 'Sealed',
  'envelope.downloaded': 'Sealed PDF downloaded',
  'envelope.verified': 'Audit chain verified',
  'email.sent': 'Email sent',
  'email.failed': 'Email failed',
  'recipient.opened': 'Recipient opened',
  'recipient.consent_given': 'Consent recorded',
  'recipient.field_filled': 'Field filled',
  'recipient.signed': 'Recipient signed',
  'recipient.declined': 'Recipient declined',
};

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
  const orgKey = sealed
    ? await prisma.orgSigningKey.findUnique({ where: { id: sealed.signedByKeyId } })
    : null;

  const canVoid =
    env.type === 'DOCUMENT' &&
    (env.status === 'DRAFT' || env.status === 'SENT' || env.status === 'IN_PROGRESS');
  const canSaveTemplate =
    env.type === 'DOCUMENT' &&
    (env.status === 'COMPLETED' || env.status === 'IN_PROGRESS' || env.status === 'SENT');

  return (
    <div className="min-h-screen bg-page">
      <div className="mx-auto max-w-6xl px-6 py-8 lg:py-12">
        <nav className="mb-8 flex items-center justify-between text-meta">
          <Link href="/dashboard" className="text-ink-secondary hover:text-ink transition-colors inline-flex items-center gap-1">
            <span aria-hidden="true">←</span> Back to envelopes
          </Link>
          <form action={logoutAction}>
            <Button type="submit" variant="ghost" size="sm">Sign out</Button>
          </form>
        </nav>

        {/* Title strip */}
        <div className="border-b border-hairline pb-6 fade-up-1">
          <SectionLabel>{env.type === 'TEMPLATE' ? 'Template' : 'Envelope'}</SectionLabel>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h1
              className="font-display text-display-1 text-ink"
             
            >
              {env.title}
            </h1>
            <StatusBadge status={env.status} className="self-start sm:self-auto" />
          </div>
          {env.message && (
            <blockquote className="mt-4 max-w-2xl border-l-2 border-accent pl-4 italic font-display text-[18px] text-ink-secondary">
              “{env.message}”
            </blockquote>
          )}
          {env.voidReason && (
            <Banner tone="warning" className="mt-4">
              Voided: <span className="italic">{env.voidReason}</span>
            </Banner>
          )}
        </div>

        {/* Metadata bar */}
        <div className="mt-6 grid grid-cols-2 gap-4 text-meta sm:grid-cols-4 fade-up-2">
          <Meta label="Recipients" value={`${env.recipients.length}`} />
          <Meta label="Routing" value={env.routingMode.toLowerCase()} />
          <Meta label="Created" value={relativeTime(env.createdAt)} />
          <Meta label="ID" value={<span className="font-mono text-[11px]">{env.id.slice(0, 12)}…</span>} />
        </div>

        <div className="mt-10 grid grid-cols-1 gap-10 lg:grid-cols-[1.6fr_1fr] fade-up-3">
          {/* Main column */}
          <div className="space-y-10 min-w-0">
            {/* Recipients vertical stepper */}
            <section>
              <SectionLabel>Recipients</SectionLabel>
              <h2 className="mt-2 font-display text-h1 text-ink">Signing sequence</h2>
              <ol className="relative mt-6">
                <span className="absolute left-[14px] top-3 bottom-3 w-px bg-hairline" aria-hidden="true" />
                {env.recipients.map((r, idx) => (
                  <li key={r.id} className="relative flex gap-4 pb-6 last:pb-0">
                    <RecipientStepDot status={r.signingStatus} index={idx} />
                    <div className="flex-1 min-w-0 -mt-0.5">
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <p className="font-medium text-ink">{r.name}</p>
                        <p className="text-meta text-ink-tertiary">{r.email}</p>
                        <span className="ml-auto"><StatusBadge status={r.signingStatus} /></span>
                      </div>
                      {r.signedAt && (
                        <p className="mt-1 font-mono text-[12px] text-ink-tertiary tnum">
                          signed {relativeTime(r.signedAt)} · ip {r.ipAddress ?? '?'}
                        </p>
                      )}
                      {r.declineReason && (
                        <p className="mt-1 italic text-meta text-status-declined">“{r.declineReason}”</p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            {/* Audit timeline */}
            <section>
              <SectionLabel>Audit trail</SectionLabel>
              <h2 className="mt-2 font-display text-h1 text-ink">Every state change, hash-chained</h2>
              <p className="mt-1.5 text-meta text-ink-secondary">
                {auditEvents.length} event{auditEvents.length === 1 ? '' : 's'} signed with the org key.
              </p>
              <ol className="mt-6 space-y-2.5">
                {auditEvents.map((e) => (
                  <li key={e.id} className="grid grid-cols-[88px_1fr] gap-4 items-baseline">
                    <span className="font-mono text-[11px] text-ink-tertiary tnum tracking-tight">
                      § {String(e.seq).padStart(2, '0')}
                    </span>
                    <div>
                      <span className="text-[14px] text-ink">{eventLabel[e.type] ?? e.type}</span>
                      {e.actorEmail && (
                        <span className="text-[14px] text-ink-secondary"> — {e.actorEmail}</span>
                      )}
                      <span className="ml-2 font-mono text-[11px] text-ink-tertiary tnum">
                        {relativeTime(e.createdAt)}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </div>

          {/* Right rail */}
          <aside className="space-y-6">
            {sealed && (
              <Banner tone="success">
                <div className="flex-1">
                  <p className="font-medium">Sealed and complete.</p>
                  <p className="mt-1 text-[12px] opacity-80">
                    All parties have signed. The sealed PDF embeds a signed JSON manifest of this audit chain.
                  </p>
                </div>
              </Banner>
            )}

            {/* Actions */}
            <Card>
              <CardBody className="p-5 sm:p-5">
                <SectionLabel>Actions</SectionLabel>
                <div className="mt-3 flex flex-col gap-2">
                  {sealed && (
                    <Button variant="primary" size="md" asChild>
                      <Link href={`/dashboard/envelopes/${env.id}/sealed`}>Download sealed PDF</Link>
                    </Button>
                  )}
                  <Button variant="secondary" size="md" asChild>
                    <Link href={`/dashboard/envelopes/${env.id}/audit.json`}>Download audit (JSON)</Link>
                  </Button>
                  {canSaveTemplate && (
                    <SaveAsTemplateButton envelopeId={env.id} suggestedTitle={`${env.title} template`} />
                  )}
                  {canVoid && <VoidEnvelopeButton envelopeId={env.id} />}
                </div>
              </CardBody>
            </Card>

            {/* Cryptographic attestation */}
            {sealed && orgKey && (
              <Card>
                <CardBody className="p-5 sm:p-5">
                  <div className="flex items-start justify-between gap-2">
                    <SectionLabel>Cryptographic attestation</SectionLabel>
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium tracking-[0.05em] uppercase text-status-completed">
                      <ShieldCheck /> Verified
                    </span>
                  </div>
                  <dl className="mt-3 space-y-2.5 text-meta">
                    <Attest label="Document SHA-256" value={sealed.documentFile.sha256} />
                    <Attest label="Audit chain head" value={sealed.chainHeadHash} />
                    <Attest label="Org key fingerprint" value={`${orgKey.fingerprint} (ed25519)`} />
                  </dl>
                  <p className="mt-4 text-[11px] text-ink-tertiary leading-relaxed">
                    Verify offline:
                    <span className="block font-mono mt-1.5 break-all text-[10px] text-ink-secondary">
                      npm run verify -- &lt;sealed.pdf&gt;
                    </span>
                  </p>
                </CardBody>
              </Card>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-l-2 border-hairline pl-3">
      <p className="text-label font-medium uppercase tracking-label text-ink-tertiary">{label}</p>
      <p className="mt-0.5 text-[14px] text-ink truncate">{value}</p>
    </div>
  );
}

function Attest({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-tertiary">{label}</dt>
      <dd className="mt-0.5 font-mono text-[11px] text-ink-secondary break-all leading-snug">{value}</dd>
    </div>
  );
}

function RecipientStepDot({
  status,
  index,
}: {
  status: string;
  index: number;
}) {
  if (status === 'SIGNED') {
    return (
      <span className="relative z-10 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-status-completed text-white shadow-[0_0_0_4px_theme(colors.page)]">
        <CheckIcon />
      </span>
    );
  }
  if (status === 'DECLINED') {
    return (
      <span className="relative z-10 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-status-declined text-white shadow-[0_0_0_4px_theme(colors.page)]">
        <XIcon />
      </span>
    );
  }
  if (status === 'OPENED') {
    return (
      <span className="relative z-10 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-white ring-4 ring-accent-soft shadow-[0_0_0_4px_theme(colors.page)]">
        <span className="text-[11px] font-medium">{index + 1}</span>
      </span>
    );
  }
  return (
    <span className="relative z-10 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface border border-hairline-strong text-ink-tertiary shadow-[0_0_0_4px_theme(colors.page)]">
      <span className="text-[11px] font-medium">{index + 1}</span>
    </span>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
function ShieldCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  );
}
