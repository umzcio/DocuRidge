'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useEffect, useTransition } from 'react';
import { clearNotificationsAction } from '@/app/dashboard/notifications/actions';

interface Notification {
  id: string;
  type: string;
  envelopeId: string;
  envelopeTitle: string;
  actorName: string | null;
  createdAt: string;
}

export function TopBar({ notifications = [] }: { notifications?: Notification[] }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [q, setQ] = useState(sp?.get('q') ?? '');
  useEffect(() => {
    setQ(sp?.get('q') ?? '');
  }, [sp]);

  // Auto-close any open <details> dropdown when the user clicks outside it.
  // Native <details> stays open until you click the same <summary> again, which
  // feels broken next to controlled menus elsewhere in the app.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      document.querySelectorAll<HTMLDetailsElement>('details[open]').forEach((d) => {
        if (!d.contains(target)) d.removeAttribute('open');
      });
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = q.trim();
    const target = trimmed
      ? `/dashboard/envelopes?q=${encodeURIComponent(trimmed)}`
      : '/dashboard/envelopes';
    router.push(target);
  }

  return (
    <header className="sticky top-0 z-20 bg-page/85 backdrop-blur-md border-b border-hairline h-14 flex items-center pl-14 pr-4 sm:pl-6 lg:pl-8 lg:pr-8 gap-3">
      <form onSubmit={submit} className="flex-1 max-w-xl" role="search">
        <label htmlFor="topbar-search" className="sr-only">Search</label>
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-tertiary">
            <SearchIcon />
          </span>
          <input
            id="topbar-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search documents, recipients, templates…"
            className="w-full h-9 pl-9 pr-3 rounded-md bg-surface border border-hairline text-[13.5px] text-ink placeholder:text-ink-tertiary outline-none focus:border-accent focus:ring-3 focus:ring-accent/12 transition-colors"
          />
        </div>
      </form>

      <div className="ml-auto flex items-center gap-1">
        <NotificationsMenu notifications={notifications} />
        <HelpMenu />
      </div>
    </header>
  );
}

/* ─── Notifications menu ────────────────────────────────────── */
function NotificationsMenu({ notifications }: { notifications: Notification[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const hasItems = notifications.length > 0;

  function clear() {
    startTransition(async () => {
      await clearNotificationsAction();
      router.refresh();
    });
  }

  return (
    <details className="relative">
      <summary
        aria-label={`Notifications (${notifications.length} recent)`}
        className="list-none inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-secondary hover:bg-surface-muted hover:text-ink cursor-pointer relative outline-none focus-visible:ring-3 focus-visible:ring-accent/15"
      >
        <BellIcon />
        {hasItems && (
          <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-status-progress" aria-hidden="true" />
        )}
      </summary>
      <div className="absolute right-0 mt-1 w-80 rounded-lg border border-hairline bg-surface shadow-[0_8px_24px_rgba(15,17,21,0.12)] z-30">
        <div className="px-4 py-3 border-b border-hairline flex items-center justify-between">
          <p className="text-[13px] font-semibold text-ink">Notifications</p>
          {hasItems ? (
            <button
              type="button"
              onClick={clear}
              disabled={pending}
              className="text-[11px] font-medium text-ink-tertiary hover:text-status-declined disabled:opacity-50 transition-colors"
            >
              {pending ? 'Clearing…' : 'Clear all'}
            </button>
          ) : (
            <span className="text-[11px] font-mono text-ink-tertiary tabular-nums">last 24h</span>
          )}
        </div>
        {!hasItems ? (
          <p className="px-4 py-6 text-[12.5px] text-ink-tertiary text-center">You're all caught up.</p>
        ) : (
          <ul className="max-h-[420px] overflow-y-auto py-1">
            {notifications.map((n) => (
              <li key={n.id}>
                <Link
                  href={`/dashboard/envelopes/${n.envelopeId}?tab=activity`}
                  className="block px-4 py-2.5 hover:bg-surface-muted/50 transition-colors"
                >
                  <p className="text-[12.5px] text-ink leading-tight">
                    <span className="font-medium">{n.actorName ?? 'System'}</span>{' '}
                    <span className="text-ink-secondary">{verbFor(n.type)}</span>{' '}
                    <span className="text-accent">{truncate(n.envelopeTitle, 28)}</span>
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-tertiary font-mono tabular-nums">
                    {relativeTime(new Date(n.createdAt))}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <div className="border-t border-hairline px-4 py-2">
          <Link href="/dashboard/inbox" className="text-[12.5px] text-accent font-medium hover:text-accent-deep">
            View Action required →
          </Link>
        </div>
      </div>
    </details>
  );
}

/* ─── Help menu ─────────────────────────────────────────────── */
function HelpMenu() {
  return (
    <details className="relative">
      <summary
        aria-label="Help and support"
        className="list-none inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-secondary hover:bg-surface-muted hover:text-ink cursor-pointer outline-none focus-visible:ring-3 focus-visible:ring-accent/15"
      >
        <HelpIcon />
      </summary>
      <div className="absolute right-0 mt-1 w-72 rounded-lg border border-hairline bg-surface shadow-[0_8px_24px_rgba(15,17,21,0.12)] z-30">
        <div className="px-4 py-3 border-b border-hairline">
          <p className="text-[13px] font-semibold text-ink">Need help?</p>
        </div>
        <ul className="p-2">
          <HelpItem
            icon={<DocIcon />}
            title="Getting started"
            description="Send your first document in 90 seconds."
            href="/dashboard/envelopes/new"
          />
          <HelpItem
            icon={<KbdIcon />}
            title="Keyboard shortcuts"
            description="Cmd/Ctrl + K to search · Esc to close dialogs"
          />
          <HelpItem
            icon={<ShieldIcon />}
            title="Verify a sealed PDF"
            description="docker compose exec app npm run verify -- <file>"
          />
          <HelpItem
            icon={<MailIcon />}
            title="Contact your admin"
            description="DocuRidge issues are routed to your org admin."
          />
        </ul>
        <div className="border-t border-hairline px-4 py-2 flex justify-between text-[11px] text-ink-tertiary">
          <span className="font-mono">DocuRidge v1.0</span>
          <span className="font-mono">{new Date().getFullYear()}</span>
        </div>
      </div>
    </details>
  );
}

function HelpItem({ icon, title, description, href }: { icon: React.ReactNode; title: string; description: string; href?: string }) {
  const inner = (
    <div className="flex items-start gap-2.5 px-2.5 py-2 rounded-md hover:bg-surface-muted/50 transition-colors">
      <span className="mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-md bg-surface-muted text-ink-secondary flex-shrink-0">
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[12.5px] font-medium text-ink">{title}</p>
        <p className="text-[11.5px] text-ink-tertiary leading-snug">{description}</p>
      </div>
    </div>
  );
  return href ? (
    <li><Link href={href}>{inner}</Link></li>
  ) : (
    <li>{inner}</li>
  );
}

/* ─── helpers ───────────────────────────────────────────────── */
function verbFor(type: string): string {
  switch (type) {
    case 'recipient.signed': return 'signed';
    case 'recipient.declined': return 'declined';
    case 'envelope.completed': return 'completed';
    case 'envelope.sent': return 'sent';
    case 'email.failed': return 'email failed for';
    default: return type.replace(/[._]/g, ' ');
  }
}
function relativeTime(d: Date): string {
  const ms = Date.now() - d.getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return d.toLocaleDateString();
}
function truncate(s: string, n: number) { return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }

/* ─── icons ──────────────────────────────────────────────────── */
function SearchIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>); }
function BellIcon() { return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>); }
function HelpIcon() { return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>); }
function DocIcon() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>); }
function KbdIcon() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12" /></svg>); }
function ShieldIcon() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><polyline points="9 12 11 14 15 10" /></svg>); }
function MailIcon() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" /></svg>); }
