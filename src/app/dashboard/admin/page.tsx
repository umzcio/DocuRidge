import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { getEnv } from '@/lib/env';
import { BrandingForm } from './branding-form';
import { SsoForm } from './sso-form';

export const dynamic = 'force-dynamic';

const TABS = [
  { id: 'branding', label: 'Branding' },
  { id: 'sso', label: 'SSO' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'api-tokens', label: 'API tokens' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/**
 * Org administration console. Org-level configuration (branding, SSO,
 * webhooks, API tokens) lives here, separate from personal account settings.
 * ADMIN role only — everyone else lands back on their own settings page.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.role !== 'ADMIN') redirect('/dashboard/settings');

  const sp = await searchParams;
  const active: TabId = (TABS.find((t) => t.id === sp.tab)?.id ?? 'branding');

  const org = await prisma.organisation.findUnique({
    where: { id: session.orgId },
    select: {
      name: true,
      senderEmailFromName: true,
      emailFooter: true,
      brandColor: true,
      defaultFieldFont: true,
      logoBase64: true,
      logoMimeType: true,
      ssoEnabled: true,
      ssoIssuer: true,
      ssoClientId: true,
      ssoClientSecret: true,
      ssoScopes: true,
    },
  });

  const orgLogoSrc = org?.logoBase64 && org.logoMimeType
    ? `data:${org.logoMimeType};base64,${org.logoBase64}`
    : null;

  return (
    <main id="admin-main" className="px-6 lg:px-8 py-8 lg:py-10 max-w-[960px] mx-auto">
      <div>
        <h1 className="text-[26px] sm:text-[28px] font-semibold tracking-[-0.022em] text-foreground leading-tight">
          Admin
        </h1>
        <p className="mt-1 text-[14px] text-muted-foreground">
          Organization-wide configuration for {org?.name ?? 'your organization'}.
        </p>
      </div>

      <nav className="mt-6 flex flex-wrap items-center gap-1 border-b border-border" aria-label="Admin sections">
        {TABS.map((t) => {
          const isActive = t.id === active;
          return (
            <Link
              key={t.id}
              href={{ pathname: '/dashboard/admin', query: { tab: t.id } }}
              aria-current={isActive ? 'page' : undefined}
              className={`inline-flex items-center gap-2 px-4 h-9 rounded-md text-[13px] font-medium transition-colors -mb-px border-b-2 ${
                isActive
                  ? 'text-foreground border-primary'
                  : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/60'
              }`}
            >
              {tabIcon(t.id)}
              {t.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-6 rounded-lg border border-border bg-card p-6">
        {active === 'branding' && (
          <BrandingForm
            initialFromName={org?.senderEmailFromName ?? ''}
            initialEmailFooter={org?.emailFooter ?? ''}
            initialBrandColor={org?.brandColor ?? ''}
            initialFieldFont={org?.defaultFieldFont ?? 'sans'}
            initialLogoSrc={orgLogoSrc}
            orgName={org?.name ?? 'Your organization'}
          />
        )}

        {active === 'sso' && (
          <SsoForm
            initialEnabled={org?.ssoEnabled ?? false}
            initialIssuer={org?.ssoIssuer ?? ''}
            initialClientId={org?.ssoClientId ?? ''}
            hasSecret={Boolean(org?.ssoClientSecret)}
            initialScopes={org?.ssoScopes ?? 'openid profile email'}
            orgName={org?.name ?? 'your organization'}
            callbackUrl={`${getEnv().PUBLIC_URL}/api/auth/sso/callback`}
          />
        )}

        {active === 'webhooks' && <WebhooksPanel orgId={session.orgId} />}

        {active === 'api-tokens' && <ApiTokensPanel orgId={session.orgId} />}
      </div>
    </main>
  );
}

async function WebhooksPanel({ orgId }: { orgId: string }) {
  const subs = await prisma.webhookSubscription.findMany({
    where: { orgId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, url: true, enabled: true, events: true, createdAt: true, _count: { select: { calls: true } } },
  });
  const { WebhooksClient } = await import('./webhooks-client');
  return <WebhooksClient subs={subs.map((s) => ({
    id: s.id, url: s.url, enabled: s.enabled, eventCount: s.events.length,
    callCount: s._count.calls, createdAt: s.createdAt.toISOString(),
  }))} />;
}

async function ApiTokensPanel({ orgId }: { orgId: string }) {
  const tokens = await prisma.apiToken.findMany({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, scopes: true, createdAt: true,
      lastUsedAt: true, expiresAt: true, revokedAt: true,
    },
  });
  const { ApiTokenPanel } = await import('./api-token-panel');
  return <ApiTokenPanel tokens={tokens.map((t) => ({
    id: t.id,
    name: t.name,
    scopes: t.scopes.split(',').map((s) => s.trim()).filter(Boolean),
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    expiresAt: t.expiresAt?.toISOString() ?? null,
    revokedAt: t.revokedAt?.toISOString() ?? null,
  }))} />;
}

function tabIcon(id: TabId): React.ReactNode {
  const props = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  switch (id) {
    case 'branding': return (<svg {...props}><circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" /></svg>);
    case 'sso': return (<svg {...props}><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><path d="M10 17l5-5-5-5" /><path d="M15 12H3" /></svg>);
    case 'webhooks': return (<svg {...props}><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z" /></svg>);
    case 'api-tokens': return (<svg {...props}><circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.8 12.2 21 2" /><path d="M15.5 7.5l3 3" /><path d="M18.5 4.5l2 2" /></svg>);
  }
}
