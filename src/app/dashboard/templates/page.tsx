import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { listTemplates } from '@/lib/templates/service';
import { logoutAction } from '@/app/(auth)/logout/actions';

export const dynamic = 'force-dynamic';

export default async function TemplatesPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };
  const templates = await listTemplates(ctx);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <nav className="mb-6 flex items-center justify-between text-sm">
        <Link href="/dashboard" className="text-neutral-600 hover:underline">
          ← Back to dashboard
        </Link>
        <form action={logoutAction}>
          <button type="submit" className="text-neutral-600 hover:underline">Sign out</button>
        </form>
      </nav>

      <h1 className="text-2xl font-semibold tracking-tight">Templates</h1>
      <p className="mt-1 text-sm text-neutral-600">Reusable envelope structures. Save any envelope as a template, then instantiate it with new recipients.</p>

      {templates.length === 0 ? (
        <div className="mt-8 rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center">
          <p className="text-sm text-neutral-700">No templates yet.</p>
          <p className="mt-1 text-xs text-neutral-500">
            Open an envelope and click <span className="font-medium">Save as template</span> to create one.
          </p>
        </div>
      ) : (
        <ul className="mt-8 divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
          {templates.map((t) => (
            <li key={t.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Link href={`/dashboard/templates/${t.id}`} className="font-medium text-neutral-900 hover:underline">
                    {t.title}
                  </Link>
                  <div className="text-xs text-neutral-500">
                    {t.items.length} document{t.items.length === 1 ? '' : 's'} ·{' '}
                    {t.recipients.length} role{t.recipients.length === 1 ? '' : 's'} ·{' '}
                    {t._count.fields} field{t._count.fields === 1 ? '' : 's'} ·{' '}
                    used {t._count.instantiations} time{t._count.instantiations === 1 ? '' : 's'}
                  </div>
                </div>
                <Link
                  href={`/dashboard/templates/${t.id}`}
                  className="inline-flex h-8 items-center rounded-md bg-accent-700 px-3 text-xs font-medium text-white hover:bg-accent-800"
                >
                  Use template
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
