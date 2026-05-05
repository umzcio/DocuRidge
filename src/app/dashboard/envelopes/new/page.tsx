import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { NewEnvelopeForm } from './form';

export const dynamic = 'force-dynamic';

export default async function NewEnvelopePage() {
  const session = await getSession();
  if (!session) redirect('/login');

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">New envelope</h1>
      <p className="mt-1 text-sm text-neutral-600">
        Upload a PDF, add a recipient, place at least one signature field, and send.
      </p>
      <div className="mt-6 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
        <NewEnvelopeForm />
      </div>
    </div>
  );
}
