'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import { logoutAction } from '@/app/(auth)/logout/actions';
import { createFolderAction, type FolderActionState } from '@/app/dashboard/folders/actions';
import { BrandLockup } from '@/components/ui/wordmark';
import { cn } from '@/lib/util';

type NavItem = {
  label: string;
  href: string;
  icon: React.ReactNode;
  count?: number;
  match?: (path: string) => boolean;
};

type Counts = {
  total: number;
  inbox: number;
  sent: number;
  drafts: number;
  completed: number;
};

export function Sidebar({
  counts,
  folders,
  user,
}: {
  counts: Counts;
  folders: Array<{ id: string; name: string; count: number }>;
  user: { name: string; email: string; role: string; avatarSrc?: string | null };
}) {
  const pathname = usePathname() ?? '/dashboard';
  const [mobileOpen, setMobileOpen] = useState(false);

  const items: NavItem[] = [
    {
      label: 'Dashboard',
      href: '/dashboard',
      icon: <IconGrid />,
      match: (p) => p === '/dashboard',
    },
    {
      label: 'All documents',
      href: '/dashboard/envelopes',
      icon: <IconStack />,
      count: counts.total,
      match: (p) => p === '/dashboard/envelopes' || (p.startsWith('/dashboard/envelopes/') && !p.endsWith('/new')),
    },
    {
      label: 'Action required',
      href: '/dashboard/inbox',
      icon: <IconInbox />,
      count: counts.inbox,
      match: (p) => p.startsWith('/dashboard/inbox'),
    },
    {
      label: 'Sent',
      href: '/dashboard/sent',
      icon: <IconSend />,
      count: counts.sent,
      match: (p) => p.startsWith('/dashboard/sent'),
    },
    {
      label: 'Drafts',
      href: '/dashboard/drafts',
      icon: <IconDraft />,
      count: counts.drafts,
      match: (p) => p.startsWith('/dashboard/drafts'),
    },
    {
      label: 'Completed',
      href: '/dashboard/completed',
      icon: <IconCheckCircle />,
      count: counts.completed,
      match: (p) => p.startsWith('/dashboard/completed'),
    },
    {
      label: 'Templates',
      href: '/dashboard/templates',
      icon: <IconTemplate />,
      match: (p) => p.startsWith('/dashboard/templates'),
    },
  ];

  const initials = user.name.split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

  return (
    <>
      {/* Mobile toggle */}
      <button
        type="button"
        aria-label="Open navigation"
        aria-expanded={mobileOpen}
        onClick={() => setMobileOpen(true)}
        className="lg:hidden fixed top-3 left-3 z-40 inline-flex h-9 w-9 items-center justify-center rounded-md bg-[#1A2233] text-white shadow-[0_2px_8px_rgba(10,22,63,0.18)]"
      >
        <IconMenu />
      </button>

      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-canvas/40 backdrop-blur-[2px]"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={cn(
          'fixed lg:sticky top-0 z-50 lg:z-30 h-screen w-[240px] flex-shrink-0',
          'text-white/85',
          // Slate, deliberately off-blue — gives the cobalt brand icon room to breathe
          // instead of fighting the panel.
          'bg-[#1A2233]',
          'flex flex-col',
          'transition-transform duration-200',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
        {/* Brand */}
        <div className="px-5 pt-5 pb-3 flex items-center justify-between">
          <Link href="/dashboard" className="inline-flex items-center" onClick={() => setMobileOpen(false)}>
            <BrandLockup size="md" tone="onDark" />
          </Link>
          <button
            type="button"
            aria-label="Close navigation"
            className="lg:hidden p-1 text-white/60 hover:text-white"
            onClick={() => setMobileOpen(false)}
          >
            <IconX />
          </button>
        </div>

        {/* Primary CTA */}
        <div className="px-3 pt-1">
          <Link
            href="/dashboard/envelopes/new"
            onClick={() => setMobileOpen(false)}
            className="flex h-9 items-center justify-center gap-2 rounded-md bg-accent px-3 text-[13.5px] font-medium text-white border border-accent-deep shadow-[0_1px_0_rgba(0,0,0,0.15)] hover:bg-accent-deep transition-colors"
          >
            <IconPlus className="h-3.5 w-3.5" />
            New document
          </Link>
        </div>

        {/* Nav */}
        <nav className="px-2.5 py-3 flex flex-col gap-0.5 overflow-y-auto" aria-label="Primary">
          {items.map((it) => {
            const active = (it.match ?? ((p) => p === it.href))(pathname);
            return (
              <Link
                key={it.href}
                href={it.href}
                onClick={() => setMobileOpen(false)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[13px] font-medium transition-colors',
                  active
                    ? 'bg-white/10 text-white'
                    : 'text-white/65 hover:bg-white/5 hover:text-white',
                )}
              >
                <span className={cn('inline-flex h-4 w-4 items-center justify-center', active ? 'text-white' : 'text-white/55 group-hover:text-white/85')}>
                  {it.icon}
                </span>
                <span className="flex-1 truncate">{it.label}</span>
                {typeof it.count === 'number' && it.count > 0 && (
                  <span
                    className={cn(
                      'min-w-[20px] h-[18px] px-1.5 inline-flex items-center justify-center rounded-full font-mono text-[10px] tnum',
                      active
                        ? 'bg-white/15 text-white'
                        : 'bg-white/8 text-white/65 group-hover:bg-white/12',
                    )}
                  >
                    {it.count}
                  </span>
                )}
              </Link>
            );
          })}
          <div className="mt-3 mb-1 px-2.5 flex items-center justify-between text-[10px] font-mono uppercase tracking-[0.08em] text-white/40">
            <span>Folders</span>
            <NewFolderInline />
          </div>
          {folders.length > 0 && (
            <>
              {folders.map((f) => {
                const href = `/dashboard/folders/${f.id}`;
                const active = pathname === href;
                return (
                  <Link
                    key={f.id}
                    href={href}
                    onClick={() => setMobileOpen(false)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[13px] font-medium transition-colors',
                      active
                        ? 'bg-white/10 text-white'
                        : 'text-white/65 hover:bg-white/5 hover:text-white',
                    )}
                  >
                    <span className={cn('inline-flex h-4 w-4 items-center justify-center', active ? 'text-white' : 'text-white/55 group-hover:text-white/85')}>
                      <IconFolder />
                    </span>
                    <span className="flex-1 truncate">{f.name}</span>
                    {f.count > 0 && (
                      <span
                        className={cn(
                          'min-w-[20px] h-[18px] px-1.5 inline-flex items-center justify-center rounded-full font-mono text-[10px] tnum',
                          active ? 'bg-white/15 text-white' : 'bg-white/8 text-white/65 group-hover:bg-white/12',
                        )}
                      >
                        {f.count}
                      </span>
                    )}
                  </Link>
                );
              })}
            </>
          )}
        </nav>

        {/* Footer */}
        <div className="mt-auto border-t border-white/8 p-3 flex flex-col gap-1">
          <Link
            href="/dashboard/settings"
            onClick={() => setMobileOpen(false)}
            className={cn(
              'flex items-center gap-2.5 px-2.5 h-8 rounded-md text-[13px] font-medium transition-colors',
              pathname.startsWith('/dashboard/settings')
                ? 'bg-white/10 text-white'
                : 'text-white/65 hover:bg-white/5 hover:text-white',
            )}
          >
            <span className="inline-flex h-4 w-4 items-center justify-center text-white/55"><IconGear /></span>
            Settings
          </Link>

          <details className="relative">
            <summary className="list-none flex items-center gap-2.5 px-2 py-2 rounded-md cursor-pointer hover:bg-white/5 outline-none focus-visible:ring-2 focus-visible:ring-white/30">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white text-[11px] font-semibold tracking-[0.02em] overflow-hidden">
                {user.avatarSrc ? (
                  <img src={user.avatarSrc} alt="" className="h-full w-full object-cover" />
                ) : (initials || '?')}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[12.5px] font-medium text-white truncate leading-tight">{user.name}</span>
                <span className="block text-[11px] text-white/55 truncate leading-tight">{user.email}</span>
              </span>
              <IconChevronUp className="h-3 w-3 text-white/45" />
            </summary>
            <div className="absolute bottom-full left-0 right-0 mb-2 rounded-md border border-white/10 bg-canvas-edge p-1 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.5)]">
              <div className="px-2.5 py-2 border-b border-white/8">
                <p className="text-[12.5px] text-white/85 truncate">{user.name}</p>
                <p className="text-[10.5px] font-mono uppercase tracking-[0.06em] text-white/45">{user.role.toLowerCase()}</p>
              </div>
              <form action={logoutAction}>
                <button
                  type="submit"
                  className="w-full text-left px-2.5 py-1.5 rounded-md text-[13px] text-white/80 hover:bg-white/8 hover:text-white"
                >
                  Sign out
                </button>
              </form>
            </div>
          </details>
        </div>
      </aside>
    </>
  );
}

/* ─── Icons (16px, currentColor stroke) ───────────────────────── */

function svgProps(extra?: string) {
  return {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: extra ?? 'h-4 w-4',
    'aria-hidden': true as const,
  };
}

function IconGrid() {
  return (
    <svg {...svgProps()}>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </svg>
  );
}
function IconStack() {
  return (
    <svg {...svgProps()}>
      <path d="M14 2H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
function IconFolder() {
  return (
    <svg {...svgProps()}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function IconInbox() {
  return (
    <svg {...svgProps()}>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}
function IconSend() {
  return (
    <svg {...svgProps()}>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}
function IconDraft() {
  return (
    <svg {...svgProps()}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="15" y2="17" />
    </svg>
  );
}
function IconCheckCircle() {
  return (
    <svg {...svgProps()}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}
function IconTemplate() {
  return (
    <svg {...svgProps()}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  );
}
function IconGear() {
  return (
    <svg {...svgProps()}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
function IconPlus({ className }: { className?: string }) {
  return (
    <svg {...svgProps(className)}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function IconChevronUp({ className }: { className?: string }) {
  return (
    <svg {...svgProps(className)}>
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}
function IconMenu() {
  return (
    <svg {...svgProps('h-5 w-5')}>
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}
function IconX() {
  return (
    <svg {...svgProps('h-4 w-4')}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

const folderInitial: FolderActionState = { ok: false };
/**
 * Tiny inline "+" button in the sidebar Folders header that toggles a name
 * input. Submits to createFolderAction and routes into the new folder.
 */
function NewFolderInline() {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState(createFolderAction, folderInitial);
  const router = useRouter();

  useEffect(() => {
    if (state.ok && state.folderId) {
      setOpen(false);
      router.push(`/dashboard/folders/${state.folderId}`);
      router.refresh();
    }
  }, [state, router]);

  if (!open) {
    return (
      <button
        type="button"
        aria-label="Create folder"
        onClick={() => setOpen(true)}
        className="inline-flex h-5 w-5 items-center justify-center rounded text-white/55 hover:text-white hover:bg-white/5"
      >
        +
      </button>
    );
  }
  return (
    <form action={action} className="contents">
      <input
        autoFocus
        type="text"
        name="name"
        placeholder="Folder name"
        maxLength={80}
        onBlur={(e) => { if (!e.currentTarget.value) setOpen(false); }}
        className="h-6 w-32 px-1.5 rounded bg-white/10 border border-white/15 text-white text-[11px] placeholder:text-white/40 outline-none focus:border-white/40"
      />
    </form>
  );
}
