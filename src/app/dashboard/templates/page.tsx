import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { listTemplates } from '@/lib/templates/service';
import { SectionLabel } from '@/components/ui/section-label';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';

export default async function TemplatesPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };
  const templates = await listTemplates(ctx);

  return (
    <div className="mx-auto max-w-5xl px-6 lg:px-10 py-10 lg:py-14">
      <div className="fade-up-1">
        <SectionLabel>Library</SectionLabel>
        <h1
          className="mt-2 font-semibold tracking-[-0.034em] text-ink text-[44px] leading-[1.05] sm:text-[56px]"
          style={{ fontVariationSettings: '"opsz" 32' }}
        >
          Templates
        </h1>
        <p className="mt-2 text-[15px] text-ink-secondary max-w-prose">
          Reusable envelope structures. Save any envelope as a template, then instantiate it with new recipients.
        </p>
      </div>

      {templates.length === 0 ? (
        <div className="mt-12 rounded-md border border-hairline border-dashed bg-surface px-8 py-16 text-center fade-up-3">
          <SectionLabel className="text-center">Empty library</SectionLabel>
          <h2 className="mt-3 font-semibold text-ink text-[28px] tracking-[-0.028em]">No templates yet.</h2>
          <p className="mt-2 text-meta text-ink-secondary max-w-sm mx-auto">
            Open a completed envelope and choose <span className="text-ink font-medium">Save as template</span> to create one.
          </p>
        </div>
      ) : (
        <ul className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-4 fade-up-2">
          {templates.map((t) => (
            <li
              key={t.id}
              className="group rounded-md border border-hairline bg-surface p-5 transition-colors hover:border-hairline-strong"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/dashboard/templates/${t.id}`}
                    className="block focus-visible:outline-none"
                  >
                    <h3 className="font-medium text-ink text-[15px] truncate group-hover:text-accent transition-colors">
                      {t.title}
                    </h3>
                  </Link>
                  <p className="mt-1 text-[12px] text-ink-tertiary">
                    {t.items.length} doc{t.items.length === 1 ? '' : 's'} · {t.recipients.length} role{t.recipients.length === 1 ? '' : 's'} · {t._count.fields} field{t._count.fields === 1 ? '' : 's'}
                  </p>
                </div>
                <Button variant="secondary" size="sm" asChild>
                  <Link href={`/dashboard/templates/${t.id}`}>Use</Link>
                </Button>
              </div>
              <div className="mt-4 pt-4 border-t border-hairline flex items-center justify-between text-[11px] text-ink-tertiary font-mono uppercase tracking-[0.06em]">
                <span>used {t._count.instantiations}× </span>
                <span>{new Date(t.createdAt).toLocaleDateString()}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
