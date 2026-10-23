import Link from 'next/link';
import { Button } from '@/components/ui/button';

/**
 * "Sign in with SSO" affordance on the login page, one per organisation that
 * SSO_TRUSTED_ISSUERS binds to its issuer (the page checks). The href names
 * the org so /api/auth/sso/login starts that org's OIDC flow and no other.
 */
export function SsoButton({ orgName, orgSlug }: { orgName: string; orgSlug: string }) {
  return (
    <Button asChild variant="secondary" size="lg" className="w-full">
      <Link href={`/api/auth/sso/login?org=${encodeURIComponent(orgSlug)}`}>Sign in with SSO · {orgName}</Link>
    </Button>
  );
}
