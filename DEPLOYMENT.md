# DocuRidge — Deployment Notes

This document exists to back the handful of pointers to it scattered across
the codebase (`docker-compose.yml`, `src/lib/mail/allowlist.ts`,
`src/lib/env.ts`, `src/lib/storage.ts`, `SECURITY.md`). It describes only what
the current code does and the seams it leaves for production changes — it is
not a general operations runbook.

## 1. Reverse-proxy placement

The app container has no host port (see `docker-compose.yml`). It is reached
over the `docuridge_proxy_net` Docker network, which the existing `proxy`
container attaches to as an `external: true` network. The upstream `location`
blocks nginx needs are documented as a commented snippet in
`deploy/nginx/docuridge.conf` — copy them into the proxy's `nginx.conf` and
reload nginx; that file also documents the case-canonicalization redirect
DocuRidge needs (`/DocuRidge` vs `/docuridge`) and the trailing-slash gotcha
with Next.js.

## 2. Mail allowlist removal

The allowlist is a code-level gate, not just an env var:

- `isAllowlistEnforced()` (`src/lib/mail/allowlist.ts`) is only `true` when
  `MAIL_BACKEND=smtp_relay`. For any other backend (e.g. `mailhog`), the
  allowlist is not consulted at all.
- When enforced, every outbound address is checked against
  `isAllowedRecipient()`, which reads the comma-separated `MAIL_ALLOWLIST` env
  var. An empty list means nothing sends, even with a valid backend.
- The gate is called from two places: `sendMail()` in `src/lib/mail/index.ts`
  (the actual send path), and `mayMailRecipient()` at four call sites that
  pre-check before doing other work — `src/app/form/[token]/actions.ts`,
  `src/app/dashboard/bulk-send/actions.ts`, `src/app/sign/[token]/actions.ts`,
  and `src/app/dashboard/envelopes/[id]/actions.ts`.

To remove the allowlist for full production, both of these must change in the
**same commit**:

1. The env change (e.g. no longer setting `MAIL_ALLOWLIST`, or however the
   deploy chooses to represent "unrestricted").
2. The gate call sites themselves — `isAllowlistEnforced()` /
   `isAllowedRecipient()` / `mayMailRecipient()` calls listed above.

Changing only the env side (for example, setting `MAIL_ALLOWLIST` to something
that matches everything) is explicitly not the intended removal path — the
code gate is the safety net that a misconfigured env var alone cannot disable,
so removing the net has to be a deliberate code change reviewed like any other
security-relevant diff.

## 3. Virus scanning

`scanFile(buffer)` in `src/lib/storage.ts` is a no-op: it returns `'CLEAN'`
unconditionally for every upload. It is called from
`src/lib/envelopes/service.ts` at upload time, and its result flows into the
`ScanStatus` enum and the `DocumentFile.scanStatus` / `scannedAt` columns in
`prisma/schema.prisma`, which already exist to record a real result.

To swap in a real scanner (e.g. ClamAV), replace the body of `scanFile` with a
call to the scanner (over a socket, HTTP, or a CLI invocation) and map its
result to `'CLEAN' | 'INFECTED' | 'ERROR'`. No other code needs to change —
the enum, the column, and the call site are already wired for a real answer.

## 4. SSO / SAML / OIDC

Not implemented. `SECURITY.md` §7 calls the auth layer "designed as a strategy
swap," but no SSO/SAML/OIDC strategy ships today — there is no IdP wiring, no
SP metadata, and no `AUTH_STRATEGY` switch in the current code. `src/lib/auth/`
is the seam where a second strategy would be added alongside the existing
email/password flow. There is no documented wiring procedure because none
exists yet.
