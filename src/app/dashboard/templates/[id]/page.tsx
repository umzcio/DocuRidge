import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { getTemplate } from '@/lib/templates/service';
import { logoutAction } from '@/app/(auth)/logout/actions';
import { InstantiateForm } from './form';
import { PublicFormPanel } from './public-form/panel';
import { prisma } from '@/lib/prisma';
import { getEnv } from '@/lib/env';
import { canonicalRefusalMessage } from '@/lib/pdf/canonical-result';

export const dynamic = 'force-dynamic';

export default async function TemplateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const { id } = await params;
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };
  const tpl = await getTemplate(ctx, id);
  if (!tpl) notFound();

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <nav className="mb-6 flex items-center justify-between text-sm">
        <Link href="/dashboard/templates" className="text-muted-foreground hover:underline">
          ← Back to templates
        </Link>
        <form action={logoutAction}>
          <button type="submit" className="text-muted-foreground hover:underline">Sign out</button>
        </form>
      </nav>

      <h1 className="text-2xl font-semibold tracking-tight">{tpl.title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Template · {tpl.items.length} document{tpl.items.length === 1 ? '' : 's'} ·{' '}
        {tpl.recipients.length} role{tpl.recipients.length === 1 ? '' : 's'} · routing: {tpl.routingMode.toLowerCase()}
      </p>

      <div className="mt-6 rounded-lg border border-border bg-card p-6 shadow-sm">
        <h2 className="text-base font-semibold mb-3">Documents</h2>
        <ul className="text-sm text-foreground list-disc pl-5">
          {tpl.items.map((it) => (
            <li key={it.id}>
              {it.title} <span className="text-xs text-faint">({it.pageCount} page{it.pageCount === 1 ? '' : 's'})</span>
              {it.documentFile.canonicalRefusal !== null && (
                <p role="alert" className="mt-1 text-xs text-destructive">
                  This document can&apos;t be used for signing: {canonicalRefusalMessage(it.documentFile.canonicalRefusal)} Upload a replacement to use this template.
                </p>
              )}
            </li>
          ))}
        </ul>

        <h2 className="text-base font-semibold mt-6 mb-3">Fill in real recipient details</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Each role below corresponds to a recipient in the template. Provide a real name and email for the live envelope.
        </p>
        <InstantiateForm
          templateId={tpl.id}
          recipients={tpl.recipients.map((r) => ({
            id: r.id,
            roleLabel: r.roleLabel ?? r.name,
            signingOrder: r.signingOrder,
          }))}
        />
      </div>
      {await renderPublicFormPanel(tpl.id)}
    </div>
  );
}

/**
 * Server-side wrapper that loads the template's public-form state and
 * builds the absolute share URL before handing off to the client panel.
 */
async function renderPublicFormPanel(templateId: string) {
  const tpl = await prisma.envelope.findUnique({
    where: { id: templateId },
    select: { publicFormToken: true, publicFormEnabled: true },
  });
  const baseUrl = getEnv().PUBLIC_URL;
  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-6 shadow-sm">
      <PublicFormPanel
        templateId={templateId}
        enabled={!!tpl?.publicFormEnabled}
        publicUrl={tpl?.publicFormToken ? `${baseUrl}/form/${tpl.publicFormToken}` : null}
      />
    </div>
  );
}
