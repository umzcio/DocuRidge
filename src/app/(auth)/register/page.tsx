import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { RegisterForm } from './form';

export default async function RegisterPage() {
  const session = await getSession();
  if (session) redirect('/dashboard');

  return (
    <>
      <h2 className="text-xl font-semibold">Create account</h2>
      <p className="mt-1 text-sm text-neutral-600">
        Register to send and sign documents.
      </p>
      <div className="mt-6">
        <RegisterForm />
      </div>
      <p className="mt-6 text-sm text-center text-neutral-600">
        Already have an account?{' '}
        <Link href="/login" className="text-accent-700 hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
