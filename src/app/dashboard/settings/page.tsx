import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { ProfileForm } from './profile-form';
import { NotificationsForm, type NotificationPrefs } from './notifications-form';
import { BrandingForm } from './branding-form';
import { DefaultSignaturePanel } from './default-signature-panel';
import { LocalTime } from '@/components/ui/local-time';

export const dynamic = 'force-dynamic';

const TABS = [
  { id: 'profile', label: 'Profile' },
  { id: 'signatures', label: 'Signatures' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'security', label: 'Security' },
  { id: 'branding', label: 'Branding' },
  { id: 'webhooks', label: 'Webhooks' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const DEFAULT_PREFS: NotificationPrefs = {
  sentForSignature: true,
  recipientSigned: true,
  completed: true,
  declined: true,
  reminderDigest: false,
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');

  const sp = await searchParams;
  const active: TabId = (TABS.find((t) => t.id === sp.tab)?.id ?? 'profile');

  const [user, org] = await Promise.all([
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        name: true,
        email: true,
        jobTitle: true,
        phone: true,
        address: true,
        company: true,
        notificationPrefs: true,
        avatarBase64: true,
        avatarMimeType: true,
        lastSignedInAt: true,
        createdAt: true,
      },
    }),
    prisma.organisation.findUnique({
      where: { id: session.orgId },
      select: {
        name: true,
        senderEmailFromName: true,
        emailFooter: true,
        brandColor: true,
        defaultFieldFont: true,
        logoBase64: true,
        logoMimeType: true,
      },
    }),
  ]);

  const avatarSrc = user?.avatarBase64 && user.avatarMimeType
    ? `data:${user.avatarMimeType};base64,${user.avatarBase64}`
    : null;
  const orgLogoSrc = org?.logoBase64 && org.logoMimeType
    ? `data:${org.logoMimeType};base64,${org.logoBase64}`
    : null;

  return (
    <main id="settings-main" className="px-6 lg:px-8 py-8 lg:py-10 max-w-[960px] mx-auto">
      <div>
        <h1 className="text-[26px] sm:text-[28px] font-semibold tracking-[-0.022em] text-ink leading-tight">
          Settings
        </h1>
        <p className="mt-1 text-[14px] text-ink-secondary">
          Manage your profile, signatures, and account preferences.
        </p>
      </div>

      <nav className="mt-6 flex flex-wrap items-center gap-1 border-b border-hairline" aria-label="Settings sections">
        {TABS.map((t) => {
          const isActive = t.id === active;
          return (
            <Link
              key={t.id}
              href={{ pathname: '/dashboard/settings', query: { tab: t.id } }}
              aria-current={isActive ? 'page' : undefined}
              className={`inline-flex items-center gap-2 px-4 h-9 rounded-md text-[13px] font-medium transition-colors -mb-px border-b-2 ${
                isActive
                  ? 'text-ink border-accent'
                  : 'text-ink-secondary border-transparent hover:text-ink hover:bg-surface-muted/60'
              }`}
            >
              {tabIcon(t.id)}
              {t.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-6 rounded-lg border border-hairline bg-surface p-6">
        {active === 'profile' && (
          <ProfileForm
            initialFullName={user?.name ?? session.user.name}
            initialEmail={user?.email ?? session.user.email}
            initialJobTitle={user?.jobTitle ?? ''}
            initialPhone={user?.phone ?? ''}
            initialAddress={user?.address ?? ''}
            initialCompany={user?.company ?? ''}
            initialAvatarSrc={avatarSrc}
          />
        )}

        {active === 'signatures' && <SignaturesPanel userId={session.user.id} />}

        {active === 'notifications' && (
          <NotificationsForm prefs={mergePrefs(user?.notificationPrefs)} />
        )}

        {active === 'security' && (
          <SecurityPanel
            email={user?.email ?? session.user.email}
            lastSignedInAt={user?.lastSignedInAt ?? null}
            createdAt={user?.createdAt ?? new Date()}
          />
        )}

        {active === 'branding' && (
          session.role === 'ADMIN' ? (
            <BrandingForm
              initialFromName={org?.senderEmailFromName ?? ''}
              initialEmailFooter={org?.emailFooter ?? ''}
              initialBrandColor={org?.brandColor ?? ''}
              initialFieldFont={org?.defaultFieldFont ?? 'sans'}
              initialLogoSrc={orgLogoSrc}
              orgName={org?.name ?? 'Your organization'}
            />
          ) : (
            <BrandingPanel role={session.role} />
          )
        )}

        {active === 'webhooks' && (
          session.role === 'ADMIN' ? (
            <WebhooksPanel orgId={session.orgId} />
          ) : (
            <p className="text-[13px] text-ink-secondary">
              Only org admins can manage webhooks.
            </p>
          )
        )}
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

async function SignaturesPanel({ userId }: { userId: string }) {
  // List signatures the user has adopted, joined via recipients tied to the user's email.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      defaultSignaturePngBase64: true,
      defaultTypedSignature: true,
      defaultInitialsPngBase64: true,
      defaultTypedInitials: true,
    },
  });
  const signatures = user
    ? await prisma.signature.findMany({
        where: { recipient: { email: user.email.toLowerCase() } },
        orderBy: { capturedAt: 'desc' },
        take: 10,
        include: {
          recipient: { include: { envelope: { select: { id: true, title: true } } } },
        },
      })
    : [];

  return (
    <div>
      <h2 className="text-[15px] font-semibold text-ink">Default signature</h2>
      <p className="mt-1 text-[13px] text-ink-secondary">
        Pre-filled in every envelope you sign. You can always override it during a ceremony.
      </p>
      <DefaultSignaturePanel
        kind="SIGNATURE"
        pngBase64={user?.defaultSignaturePngBase64 ?? null}
        typed={user?.defaultTypedSignature ?? null}
      />
      <h2 className="mt-8 text-[15px] font-semibold text-ink">Default initials</h2>
      <p className="mt-1 text-[13px] text-ink-secondary">
        Same idea — re-used wherever an Initials field is placed.
      </p>
      <DefaultSignaturePanel
        kind="INITIALS"
        pngBase64={user?.defaultInitialsPngBase64 ?? null}
        typed={user?.defaultTypedInitials ?? null}
      />

      <h2 className="mt-10 text-[15px] font-semibold text-ink">Adopted signatures</h2>
      <p className="mt-1 text-[13px] text-ink-secondary">
        Signatures you've used to sign documents. Each adoption is recorded in the signed audit chain.
      </p>
      {signatures.length === 0 ? (
        <div className="mt-6 rounded-md border border-dashed border-hairline px-6 py-10 text-center text-[13px] text-ink-tertiary">
          No signatures adopted yet. They'll appear here after you sign your first document.
        </div>
      ) : (
        <ul className="mt-5 divide-y divide-hairline border border-hairline rounded-lg bg-surface">
          {signatures.map((s) => (
            <li key={s.id} className="flex items-center gap-4 px-4 py-3">
              <div className="flex-shrink-0 h-12 w-32 rounded border border-hairline bg-surface-muted/30 flex items-center justify-center px-2 overflow-hidden">
                {s.imagePngBase64 ? (
                  <img
                    src={`data:image/png;base64,${s.imagePngBase64}`}
                    alt="Signature preview"
                    className="max-h-10 max-w-full object-contain"
                  />
                ) : s.typedSignature ? (
                  <span className="font-sig text-[20px] text-ink truncate">{s.typedSignature}</span>
                ) : (
                  <span className="text-[10px] font-mono text-ink-tertiary uppercase">No preview</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <Link
                  href={`/dashboard/envelopes/${s.recipient.envelope.id}`}
                  className="block text-[13px] font-medium text-ink hover:text-accent truncate"
                >
                  {s.recipient.envelope.title}
                </Link>
                <p className="text-[11.5px] text-ink-tertiary">
                  Adopted {s.capturedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  {' · '}
                  {s.imagePngBase64 ? 'drawn' : 'typed'}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SecurityPanel({
  email, lastSignedInAt, createdAt,
}: { email: string; lastSignedInAt: Date | null; createdAt: Date }) {
  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">Security</h2>
        <p className="mt-1 text-[13px] text-ink-secondary">
          Manage your password and review account activity.
        </p>
      </div>

      <div className="rounded-md border border-hairline bg-surface p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[13px] font-medium text-ink">Password</p>
            <p className="text-[12px] text-ink-tertiary">
              We don't store your password — only an Argon2id hash.
            </p>
          </div>
          <Link
            href="/reset"
            className="inline-flex h-9 items-center px-3 rounded-md border border-hairline bg-surface text-[13px] font-medium text-ink hover:bg-surface-muted/60"
          >
            Change password
          </Link>
        </div>
      </div>

      <div className="rounded-md border border-hairline bg-surface p-4">
        <p className="text-[13px] font-medium text-ink">Account</p>
        <dl className="mt-2 grid grid-cols-2 gap-y-2 gap-x-4 text-[12.5px]">
          <dt className="text-ink-tertiary">Email</dt>
          <dd className="text-ink font-mono truncate">{email}</dd>
          <dt className="text-ink-tertiary">Created</dt>
          <dd className="text-ink">{createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</dd>
          <dt className="text-ink-tertiary">Last signed in</dt>
          <dd className="text-ink">{lastSignedInAt ? <LocalTime iso={lastSignedInAt.toISOString()} /> : '—'}</dd>
        </dl>
      </div>

      <p className="text-[12px] text-ink-tertiary">
        Two-factor authentication and active-session management arrive in v1.1.
      </p>
    </div>
  );
}

function BrandingPanel({ role }: { role: string }) {
  if (role !== 'ADMIN') {
    return (
      <div className="text-center py-10">
        <h2 className="text-[15px] font-semibold text-ink">Branding</h2>
        <p className="mt-2 text-[13px] text-ink-secondary max-w-md mx-auto">
          Org branding is managed by your organization administrator.
        </p>
      </div>
    );
  }
  return (
    <div className="text-center py-10">
      <h2 className="text-[15px] font-semibold text-ink">Branding</h2>
      <p className="mt-2 text-[13px] text-ink-secondary max-w-md mx-auto">
        Customize the sender name, logo, and email footer your recipients see. Org-level branding controls arrive in v1.1.
      </p>
      <p className="mt-3 inline-flex items-center px-3 py-1 rounded-full text-[11px] font-medium tracking-[0.05em] uppercase bg-surface-muted text-ink-tertiary border border-hairline">
        Coming in v1.1
      </p>
    </div>
  );
}

function mergePrefs(raw: unknown): NotificationPrefs {
  if (!raw || typeof raw !== 'object') return DEFAULT_PREFS;
  const r = raw as Record<string, unknown>;
  return {
    sentForSignature: typeof r.sentForSignature === 'boolean' ? r.sentForSignature : DEFAULT_PREFS.sentForSignature,
    recipientSigned: typeof r.recipientSigned === 'boolean' ? r.recipientSigned : DEFAULT_PREFS.recipientSigned,
    completed: typeof r.completed === 'boolean' ? r.completed : DEFAULT_PREFS.completed,
    declined: typeof r.declined === 'boolean' ? r.declined : DEFAULT_PREFS.declined,
    reminderDigest: typeof r.reminderDigest === 'boolean' ? r.reminderDigest : DEFAULT_PREFS.reminderDigest,
  };
}

function tabIcon(id: TabId): React.ReactNode {
  const props = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  switch (id) {
    case 'profile': return (<svg {...props}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>);
    case 'signatures': return (<svg {...props}><path d="M3 17l6-6 4 4 8-8" /><path d="M3 21h18" /></svg>);
    case 'notifications': return (<svg {...props}><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>);
    case 'security': return (<svg {...props}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>);
    case 'branding': return (<svg {...props}><circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" /></svg>);
    case 'webhooks': return (<svg {...props}><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z" /></svg>);
  }
}
