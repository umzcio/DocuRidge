import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { listTemplates } from '@/lib/templates/service';

export const dynamic = 'force-dynamic';

export default async function TemplatesPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };
  const templates = await listTemplates(ctx);

  return (
    <main id="templates-main" className="px-6 lg:px-8 py-8 lg:py-10 max-w-[1280px] mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[26px] sm:text-[28px] font-semibold tracking-[-0.022em] text-ink leading-tight">
            Templates
          </h1>
          <p className="mt-1 text-[14px] text-ink-secondary">
            Save reusable documents with pre-placed fields and recipient roles.
          </p>
        </div>
        <Link
          href="/dashboard/completed"
          className="inline-flex h-9 items-center gap-2 rounded-md bg-canvas px-3.5 text-[13px] font-medium text-white border border-canvas hover:bg-canvas-edge transition-colors"
          title="Open a completed document and choose Save as template"
        >
          <PlusIcon /> Save document as template
        </Link>
      </div>

      {templates.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-hairline bg-surface px-8 py-16 text-center">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-surface-muted text-ink-secondary">
            <DocIcon />
          </span>
          <h2 className="mt-3 text-[18px] font-semibold text-ink">No templates yet</h2>
          <p className="mt-1 text-[13.5px] text-ink-secondary max-w-sm mx-auto">
            Open a completed document and choose <span className="text-ink font-medium">Save as template</span> to create one.
          </p>
        </div>
      ) : (
        <ul className="mt-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {templates.map((t) => (
            <li key={t.id} className="rounded-lg border border-hairline bg-surface p-5 flex flex-col">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-surface-muted text-ink-secondary mb-3">
                <DocIcon />
              </span>
              <Link href={`/dashboard/templates/${t.id}`} className="block focus-visible:outline-none">
                <h3 className="text-[15px] font-semibold text-ink hover:text-accent transition-colors">{t.title}</h3>
              </Link>
              <p className="mt-1 text-[12.5px] text-ink-secondary line-clamp-2 leading-snug">
                {t.items.length} document{t.items.length === 1 ? '' : 's'} · {t._count.fields} field{t._count.fields === 1 ? '' : 's'}
              </p>

              {t.recipients.length > 0 && (
                <div className="mt-4">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Recipient roles</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {t.recipients.map((r, i) => (
                      <span
                        key={r.id}
                        className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-surface-muted text-ink-secondary border border-hairline"
                        style={i === 0 ? { background: '#E5E9FF', color: '#1A2FBF', borderColor: '#C7D0FF' } : undefined}
                      >
                        {r.roleLabel || r.name || `Signer ${i + 1}`}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-auto pt-4 flex items-center justify-between text-[11.5px] text-ink-tertiary">
                <span>{t._count.instantiations} use{t._count.instantiations === 1 ? '' : 's'}</span>
                <span>Created {new Date(t.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <Link
                  href={`/dashboard/templates/${t.id}`}
                  className="inline-flex h-9 items-center justify-center rounded-md border border-hairline bg-surface px-3 text-[13px] font-medium text-ink hover:border-hairline-strong hover:bg-surface-muted/60 transition-colors"
                >
                  Use template
                </Link>
                <Link
                  href={`/dashboard/templates/${t.id}/bulk`}
                  className="inline-flex h-9 items-center justify-center rounded-md border border-hairline bg-surface px-3 text-[13px] font-medium text-ink hover:border-hairline-strong hover:bg-surface-muted/60 transition-colors"
                  title="Send this template to many recipients via CSV"
                >
                  Bulk send
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function PlusIcon() {
  return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>);
}
function DocIcon() {
  return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" /></svg>);
}
