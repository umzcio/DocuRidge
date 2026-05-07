import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { listTemplates } from '@/lib/templates/service';
import { NewEnvelopeForm } from './form';

export const dynamic = 'force-dynamic';

export default async function NewEnvelopePage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };
  const templates = await listTemplates(ctx).catch(() => []);
  const topTemplates = templates.slice(0, 4);

  return (
    <main id="new-main" className="px-6 lg:px-8 py-8 lg:py-10 max-w-[1280px] mx-auto">
      <div>
        <h1 className="text-[26px] sm:text-[28px] font-semibold tracking-[-0.022em] text-ink leading-tight">
          Start a new document
        </h1>
        <p className="mt-1 text-[14px] text-ink-secondary">
          Upload a document or pick a template to get started.
        </p>
      </div>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
        {/* Main: builder form */}
        <div>
          <NewEnvelopeForm />
        </div>

        {/* Side: templates */}
        <aside className="rounded-lg border border-hairline bg-surface self-start">
          <div className="px-5 pt-5 pb-3 border-b border-hairline flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-surface-muted text-ink-secondary">
              <TemplateIcon />
            </span>
            <div>
              <h2 className="text-[14.5px] font-semibold text-ink">Use a template</h2>
              <p className="text-[12.5px] text-ink-tertiary">Skip the prep — start from a saved template.</p>
            </div>
          </div>
          <div className="p-3">
            {topTemplates.length === 0 ? (
              <div className="px-3 py-8 text-center text-[12.5px] text-ink-tertiary">
                <p>No templates yet.</p>
                <Link href="/dashboard/templates" className="mt-2 inline-block text-accent hover:text-accent-deep font-medium">
                  Manage templates →
                </Link>
              </div>
            ) : (
              <ul className="flex flex-col gap-1">
                {topTemplates.map((t) => (
                  <li key={t.id}>
                    <Link
                      href={`/dashboard/templates/${t.id}`}
                      className="block rounded-md px-3 py-2.5 hover:bg-surface-muted/60 transition-colors"
                    >
                      <span className="block text-[13px] font-medium text-ink truncate">{t.title}</span>
                      <span className="block text-[11.5px] text-ink-tertiary mt-0.5">
                        {t.recipients.length} role{t.recipients.length === 1 ? '' : 's'}
                        {t._count.instantiations > 0 && ` · ${t._count.instantiations} use${t._count.instantiations === 1 ? '' : 's'}`}
                      </span>
                    </Link>
                  </li>
                ))}
                <li className="pt-1 mt-1 border-t border-hairline">
                  <Link href="/dashboard/templates" className="block px-3 py-2 text-[12.5px] text-accent font-medium hover:text-accent-deep">
                    View all templates →
                  </Link>
                </li>
              </ul>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}

function TemplateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  );
}
