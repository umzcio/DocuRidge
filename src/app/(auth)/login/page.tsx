import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { LoginForm } from './form';

export default async function LoginPage() {
  const session = await getSession();
  if (session) redirect('/dashboard');

  return (
    <>
      <h2 className="text-xl font-semibold">Sign in</h2>
      <p className="mt-1 text-sm text-neutral-600">Welcome back.</p>
      <div className="mt-6">
        <LoginForm />
      </div>
      <div className="mt-6 flex flex-col gap-2 text-sm text-center">
        <Link href="/reset" className="text-accent-700 hover:underline">
          Forgot your password?
        </Link>
        <Link href="/register" className="text-neutral-600 hover:underline">
          Don&apos;t have an account? Create one
        </Link>
      </div>
    </>
  );
}
