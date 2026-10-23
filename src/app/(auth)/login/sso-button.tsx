import Link from 'next/link';
import { Button } from '@/components/ui/button';

/**
 * "Sign in with SSO" affordance on the login page. Rendered only when at
 * least one organisation has SSO enabled (the page checks); href starts the
 * OIDC flow in /api/auth/sso/login.
 */
export function SsoButton({ orgName }: { orgName: string }) {
  return (
    <Button asChild variant="secondary" size="lg" className="w-full">
      <Link href="/api/auth/sso/login">Sign in with SSO · {orgName}</Link>
    </Button>
  );
}
