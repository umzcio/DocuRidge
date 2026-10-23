import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { Banner } from '@/components/ui/banner';
import { SectionLabel } from '@/components/ui/section-label';
import { LoginForm } from './form';
import { SsoButton } from './sso-button';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sso?: string }>;
}) {
  const session = await getSession();
  if (session) redirect('/dashboard');

  const sp = await searchParams;
  // v1 assumes a single IdP for the deployment; if several orgs enable SSO,
  // the flow uses the most recently created one (same resolution as the
  // /api/auth/sso/login route).
  const ssoOrg = await prisma.organisation.findFirst({
    where: { ssoEnabled: true },
    orderBy: { createdAt: 'desc' },
    select: { name: true },
  });

  return (
    <>
      <SectionLabel>Sign in</SectionLabel>
      <h2 className="mt-2 font-display text-display-2 text-foreground">Welcome back.</h2>
      <p className="mt-2 text-meta text-muted-foreground">
        Sign in to manage documents and view your audit trails.
      </p>
      {sp.sso === 'error' && (
        <div className="mt-6">
          <Banner tone="error" role="alert">
            Single sign-on didn&apos;t complete. Try again, or sign in with your email and password below.
          </Banner>
        </div>
      )}
      <div className="mt-8">
        <LoginForm />
      </div>
      {ssoOrg && (
        <div className="mt-6">
          <div className="flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-border" />
            <span className="text-[11.5px] text-faint">or</span>
            <span className="h-px flex-1 bg-border" />
          </div>
          <div className="mt-4">
            <SsoButton orgName={ssoOrg.name} />
          </div>
        </div>
      )}
      <div className="mt-6 flex flex-col gap-2.5 text-meta">
        <Link
          href="/reset"
          className="text-primary underline underline-offset-2 decoration-1 hover:decoration-2 self-start"
        >
          Forgot your password?
        </Link>
        <p className="text-muted-foreground">
          Don&apos;t have an account?{' '}
          <Link href="/register" className="text-primary underline underline-offset-2 decoration-1 hover:decoration-2">
            Create one
          </Link>
        </p>
      </div>
    </>
  );
}
