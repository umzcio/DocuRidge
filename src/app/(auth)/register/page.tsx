import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { SectionLabel } from '@/components/ui/section-label';
import { RegisterForm } from './form';

export default async function RegisterPage() {
  const session = await getSession();
  if (session) redirect('/dashboard');

  return (
    <>
      <SectionLabel>Create account</SectionLabel>
      <h2 className="mt-2 font-display text-display-2 text-ink">Begin signing.</h2>
      <p className="mt-2 text-meta text-ink-secondary">
        Register an organisation to send and sign documents.
      </p>
      <div className="mt-8">
        <RegisterForm />
      </div>
      <p className="mt-6 text-meta text-ink-secondary">
        Already have an account?{' '}
        <Link href="/login" className="text-accent underline underline-offset-2 decoration-1 hover:decoration-2">
          Sign in
        </Link>
      </p>
    </>
  );
}
