import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { SectionLabel } from '@/components/ui/section-label';
import { LoginForm } from './form';

export default async function LoginPage() {
  const session = await getSession();
  if (session) redirect('/dashboard');

  return (
    <>
      <SectionLabel>Sign in</SectionLabel>
      <h2 className="mt-2 font-display text-display-2 text-ink">Welcome back.</h2>
      <p className="mt-2 text-meta text-ink-secondary">
        Sign in to manage documents and view your audit trails.
      </p>
      <div className="mt-8">
        <LoginForm />
      </div>
      <div className="mt-6 flex flex-col gap-2.5 text-meta">
        <Link
          href="/reset"
          className="text-accent underline underline-offset-2 decoration-1 hover:decoration-2 self-start"
        >
          Forgot your password?
        </Link>
        <p className="text-ink-secondary">
          Don&apos;t have an account?{' '}
          <Link href="/register" className="text-accent underline underline-offset-2 decoration-1 hover:decoration-2">
            Create one
          </Link>
        </p>
      </div>
    </>
  );
}
