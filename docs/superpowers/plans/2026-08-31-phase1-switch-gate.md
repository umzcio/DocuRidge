# Phase 1 — Switch Gate Implementation Plan

> **For agentic workers:** Workstreams W1–W5 run in PARALLEL on one working
> tree with strict file ownership (below). Do not edit files outside your
> workstream's ownership list. Schema migration is already applied.

**Goal:** Ship the five switch-gate features from
`docs/superpowers/specs/2026-08-31-docusign-switch-roadmap.md`: per-recipient
access codes, envelope correction, completion package (certificate PDF +
audit JSON), contract pipeline reporting, and configurable OIDC SSO.

**Architecture:** Each workstream is an independent vertical slice (schema →
server action → UI → test) following existing repo patterns: zod-validated
server actions in `*/actions.ts` consumed via `useActionState`, Radix
`Dialog` from `@/components/ui/dialog`, `Button`/`Input` from
`@/components/ui/*`, sonner toasts (`import { toast } from 'sonner'`), and the
token-based signing ceremony under `src/app/sign/[token]/`.

**Tech Stack:** Next.js 15 App Router, React 19, Prisma 5, Tailwind v4 token
classes (`bg-card`, `text-foreground`, `border-border`, `text-faint`,
`text-muted-foreground`, `bg-muted`, `bg-primary`, `text-destructive`…),
vitest for unit tests.

## Global Constraints

- Token vocabulary only — never `bg-surface`/`text-ink`/`neutral-*` etc.
- Match repo style: 2-space indent, single quotes, semicolons.
- Every server action validates input with zod and checks authorization
  (org membership / envelope ownership) before writes.
- New audit-relevant events go through the existing audit module
  (`src/lib/audit/…`) — agents must read how `envelope.*` events are
  recorded and follow that exact pattern.
- No git commits. No `docker compose` / Playwright runs (integration owner
  runs those at the end). `npm run typecheck`, `npm run lint`, `npm test`
  are the per-workstream verification commands.
- Already-applied schema (do NOT re-migrate; `prisma migrate deploy` only):
  - `Recipient.accessCodeHash String?` (SHA-256 hex of the access code)
  - `Organisation.ssoEnabled/ssoIssuer/ssoClientId/ssoClientSecret/ssoScopes`
  - `User.ssoSubject/ssoOrgId` (+ index)

## Shared Files (read-only for all agents)

- `prisma/schema.prisma` — the source of truth for the new fields above.
- `src/components/ui/dialog.tsx`, `select.tsx`, `button.tsx`, `input.tsx`,
  `banner.tsx` — available as-is.
- `src/lib/util.ts` — `cn()`.

---

### W1 — Per-recipient access codes

**Owns:** Create `src/lib/access-code.ts`, `src/lib/access-code.test.ts`.
Modify: `src/app/dashboard/envelopes/new/form.tsx`,
`src/app/sign/[token]/ceremony.tsx`, `src/app/sign/[token]/actions.ts`,
`src/app/sign/[token]/page.tsx` (only if needed for the gate), and the
envelope-creation action that persists recipients
(`src/app/dashboard/envelopes/new/actions.ts` or wherever
`createAndSendEnvelopeAction` lives — read first).

**Interfaces produced:**
- `hashAccessCode(code: string): string` — lowercase-trim → SHA-256 hex
  (node:crypto).
- `verifyAccessCode(hash: string | null, attempt: string): boolean` —
  constant-work compare; `hash === null` returns true.
- Server action `verifyRecipientAccessCodeAction(token, code)` →
  `{ ok: boolean; error?: string }`; on success sets a signed, short-lived
  cookie (reuse the JWS helpers in `src/lib/` — read how signing tokens are
  minted) named `dr_access_<recipientId>`; on failure increments a
  per-recipient attempt counter via the existing rate-limit helper
  (`checkRateLimit`, action `'signing_token'` bucket) and returns a generic
  error after 5 failures.
- `Recipient.accessCodeHash` is set at envelope creation when the sender
  filled the optional "Access code" field in the add-recipient modal
  (6-char default, sender can customize, A–Z 0–9, stored hashed via
  `hashAccessCode`).

**Ceremony gate:** in `SigningCeremony`, after the consent stage and before
the sign stage renders, if the recipient row for this token has
`accessCodeHash` set and the cookie is absent/invalid, render an
access-code entry step (Dialog-like centered card is fine, or inline stage):
input + "Unlock document" button → `verifyRecipientAccessCodeAction` → on
ok, `router.refresh()` or state bump to proceed. Keep the gate inside the
existing phase machine (`'consent' | 'sign' | …` → add `'unlock'` between
consent and sign; `consentAlreadyGiven` handling must still work).

**Tests:** unit tests for hash/verify (case-insensitivity, null hash true,
mismatch false). Update the temp-free e2e helpers ONLY if needed — instead
add unit coverage; do not touch `tests/`.

**Acceptance:** sender can set an optional code per recipient; recipient
with a code is prompted before signing; wrong code errors generically and
rate-limits; without a code the ceremony is unchanged; typecheck+lint+unit
green.

---

### W2 — Envelope correction

**Owns:** Create `src/app/dashboard/envelopes/[id]/correct-button.tsx`.
Modify: `src/app/dashboard/envelopes/[id]/actions.ts`,
`src/app/dashboard/envelopes/[id]/page.tsx`. Read (do not modify):
`save-template-button.tsx`, `void-button.tsx` for button placement idiom.

**Interfaces produced:**
- Server action `correctEnvelopeAction(prev, formData)` →
  `{ ok: boolean; error?: string; corrected?: boolean }`, operations
  (each recorded in the audit chain as `envelope.corrected` with before/after
  detail, following the existing audit-event pattern):
  - `updateMessage` / `updateExpiration` (when envelope is SENT or
    IN_PROGRESS and not completed/declined/voided).
  - `addRecipient(name, email, role)` — appends at the end of the pending
    sequence (signingOrder = max+1), token minted, notification email sent
    via existing mail helpers (reuse exactly how `send` notifies).
  - `replaceRecipient(recipientId, name, email)` — only recipients with
    `signingStatus = NOT_SIGNED` and `sentAt` null or re-sendable; old token
    revoked (clear `tokenJti`), new token minted, email resent.
  - `removeRecipient(recipientId)` — only `NOT_SIGNED` recipients; refuse if
    it would leave a sequential envelope with no remaining signers.
  - Refuse all mutations when envelope is COMPLETED / DECLINED / VOIDED /
    EXPIRED, and refuse edits to recipients who already signed.
- `CorrectButton` client component rendered on the detail page for
  SENT/IN_PROGRESS envelopes, org-member gated the same way adjacent buttons
  are. Dialog UI: current recipients list with per-pending-recipient
  replace/remove, add-recipient row, message textarea, expiration date
  input, Save button (uses `useActionState` + sonner success toast).

**Tests:** unit-test the action's guard logic where feasible (extract pure
`canCorrectEnvelope(status)` / `canMutateRecipient(recipient)` helpers into
`src/app/dashboard/envelopes/[id]/correction.ts` + `.test.ts` so vitest
covers the matrix without a DB).

**Acceptance:** corrections work end-to-end per rules above; every change
appears in the envelope audit log; signed recipients immutable; typecheck +
lint + unit green.

---

### W3 — Completion package (certificate + audit JSON)

**Owns:** Create `src/lib/completion-certificate.ts`,
`src/lib/completion-certificate.test.ts`,
`src/app/dashboard/envelopes/[id]/certificate/route.ts`,
`src/app/dashboard/envelopes/[id]/certificate-button.tsx`.

**Do NOT modify** `[id]/page.tsx` — the integration owner adds the button
after W2 lands.

**Interfaces produced:**
- `buildCompletionCertificate(input: { envelopeTitle: string; completedAt:
  Date; senderName: string; recipients: Array<{ name: string; email: string;
  signedAt: Date | null; declinedAt: Date | null; ipAddress: string | null }>;
  auditChainHash: string; verifyInstructions: string }): Promise<Uint8Array>`
  — a one-page PDF via the existing `pdf-lib` dependency: title
  "Certificate of Completion", envelope metadata block, recipient table
  (name, email, completed/declined timestamp, IP), the envelope's audit
  chain digest, and a "How to verify" box stating the `npm run verify`
  command. Follow fonts/patterns from `src/lib/signing/` PDF code.
- Route `GET certificate/route.ts` — auth-gated like the sibling
  `sealed/route.ts` and `audit.json/route.ts` (read them; copy the gating),
  returns `application/pdf` with `Content-Disposition: attachment;
  filename="completion-certificate.pdf"`.
- `CertificateButton` — link-styled button (`href` to the route) shown for
  COMPLETED envelopes.

**Tests:** unit-test `buildCompletionCertificate` renders (pdf-lib
`PDFDocument.load` the output and assert page count + extracted text
contains the title and recipient email — use `StandardFonts.Helvetica`
`getTextContent`-style assertions as done elsewhere in the repo if present,
else assert structural facts).

**Acceptance:** certificate downloads for completed envelopes only, mirrors
sibling-route auth, contains audit digest + verify instructions; typecheck +
lint + unit green.

---

### W4 — Contract pipeline reporting

**Owns:** Create `src/app/dashboard/pipeline/page.tsx`,
`src/app/dashboard/pipeline/pipeline-table.tsx` (client bits if needed),
`src/app/dashboard/pipeline/export/route.ts`, and
`src/app/dashboard/pipeline/pipeline.test.ts` (unit-test pure helpers).
Modify: `src/components/dashboard/sidebar.tsx` (add nav item "Pipeline"
with an `IconActivity`-style inline SVG matching the file's icon idiom,
placed after "Completed", counts optional — skip counts).

**Interfaces produced:**
- Pure helpers in `src/app/dashboard/pipeline/query.ts`:
  `pipelineQuery(orgId, { status?, senderId?, from?, to? })` returning
  rows `{ id, title, status, updatedAt, sentAt, senderName, currentSigners:
  string[], daysPending: number }` where `currentSigners` = names of
  recipients with `signingStatus = NOT_SIGNED` (limit 3 + "+N"), and
  `daysPending` = days since `sentAt ?? updatedAt`. Unit-test this helper
  with a mocked prisma delegate (follow the mocking style used in existing
  `src/lib/**/*.test.ts` that touch prisma).
- `page.tsx` (server component, same layout shell as other dashboard list
  pages — read `src/app/dashboard/sent/page.tsx` or the envelopes list):
  filter bar (status Select reusing `@/components/ui/select`, sender
  text search via GET form like envelope filters, date from/to inputs) +
  table (title link to detail, status badge via `StatusBadge`, sender,
  current signers, days pending with a `text-destructive` highlight when
  > 7). Default scope: SENT + IN_PROGRESS, ordered by daysPending desc,
  paginated at 50.
- `export/route.ts` — same query as CSV (`text/csv`,
  `Content-Disposition: attachment; filename="pipeline.csv"`), columns
  matching the table + recipient emails. Auth-gate like other dashboard
  pages (read how `requireUser`/org context is obtained in a server
  component there and mirror it).

**Acceptance:** sidebar link works; filters affect table and CSV; CSV
matches visible columns; org-scoped (no cross-org leakage — verify the
query filters `orgId`); typecheck + lint + unit green.

---

### W5 — Configurable OIDC SSO (Entra-ready)

**Owns:** Create `src/lib/auth/oidc.ts`, `src/lib/auth/oidc.test.ts`,
`src/app/api/auth/sso/login/route.ts`,
`src/app/api/auth/sso/callback/route.ts`,
`src/app/dashboard/settings/sso-form.tsx`,
`src/app/(auth)/login/sso-button.tsx`. Modify:
`src/app/dashboard/settings/page.tsx` (add an "SSO / Single sign-on"
section rendering `SsoForm`, admin-gated the same way neighboring settings
sections are), `src/app/(auth)/login/page.tsx` (render `SsoButton`),
`src/lib/auth/session.ts` ONLY if a reusable `createSessionForUser(userId,
orgId)` helper doesn't already exist (read first; prefer adding a small
exported helper there over duplicating session logic).

**Interfaces produced:**
- `discoverIssuer(issuer: string, fetchImpl = fetch): Promise<{ 
  authorizationEndpoint: string; tokenEndpoint: string; userinfoEndpoint:
  string }>` — GET `${issuer}/.well-known/openid-configuration`, zod-parse
  the three endpoints.
- `buildAuthorizeUrl(cfg, { state, nonce, redirectUri }): string` —
  `authorization_endpoint?client_id=…&response_type=code&scope=…
  &redirect_uri=…&state=…&nonce=…` (URLSearchParams).
- `exchangeCode(cfg, code, redirectUri, fetchImpl = fetch): Promise<{
  accessToken: string; idToken: string }>` — POST token endpoint,
  `application/x-www-form-urlencoded`, basic auth via client_id:secret.
- `fetchUserInfo(endpoint, accessToken, fetchImpl = fetch): Promise<{
  sub: string; email: string; name?: string }>` — zod-validate.
- Login route: resolve the SSO-enabled org (for v1: the organisation whose
  `ssoEnabled = true` — if multiple, use the most recently created; read
  how org resolution works elsewhere and keep it simple), generate
  state+nonce, store them in an HttpOnly short-lived cookie
  (`dr_oidc_state`, 10 min), 302 to `buildAuthorizeUrl`. If no org has SSO
  enabled, 404.
- Callback route: verify state cookie; exchange code; fetch userinfo;
  JIT-provision: find user by `(ssoSubject, ssoOrgId)`, else by
  case-insensitive email within the org — if found and unlinked, link
  (`ssoSubject/ssoOrgId` set); if not found, create user (name from
  userinfo, `passwordHash: null`, emailVerifiedAt: now) + OrgMember with
  the org's default member role (read how registration assigns roles and
  mirror); then create the standard app session via the session helper and
  redirect to `/dashboard`. Any failure → redirect to `/login?sso=error`.
- `SsoForm` (settings, admin/owner-gated): enable toggle, issuer, client
  ID, client secret (password input, placeholder shows whether set), scopes
  (default `openid profile email`), helper text noting Entra's redirect URI
  must be `${PUBLIC_URL}/api/auth/sso/callback` — discover `PUBLIC_URL`
  from env conventions in the repo. Server action `saveSsoConfigAction`
  validates with zod (issuer must be https URL; secret min 8 chars), saves
  to `Organisation`, audit-logs the change if an admin-audit pattern exists.
- `SsoButton` (login page): if any org has SSO enabled, render
  "Sign in with SSO" button linking to `/api/auth/sso/login`; display the
  org name. Handle `?sso=error` with a sonner/error banner (the login page
  already renders form errors via Banner — follow that).
- Note in code comments: PKCE is deliberately deferred ( Entra supports
  confidential-client without it; document as follow-up), and client
  secret prefers `SSO_CLIENT_SECRET_<ORGSLUG>` env override if the env
  module pattern makes that easy — otherwise leave the DB-stored secret
  with a comment marking the hardening path.

**Tests:** unit-test `buildAuthorizeUrl` (exact URL incl. encoding),
`discoverIssuer`/`exchangeCode`/`fetchUserInfo` with injected `fetchImpl`
stubs (success + error paths), and the JIT-provisioning decision as a pure
function `resolveSsoUser(prisma)({ sub, email, orgId })` returning
`'linked' | 'created' | 'matched'` so vitest covers it with a mocked
delegate.

**Acceptance:** with SSO configured, "Sign in with SSO" redirects through
the IdP and lands a provisioned user on /dashboard; personal login
unchanged; with SSO disabled the button is absent and routes 404; typecheck
+ lint + unit green.

---

## Integration sequence (owner: orchestrator, after all W* report green)

1. `npm run typecheck && npm run lint && npm test` on the merged tree.
2. Add W3's `CertificateButton` to `envelopes/[id]/page.tsx` next to
   forward/download affordances.
3. `npm run e2e:up && npm run test:e2e:isolated` — extend the suite only if
   a workstream left a spec; expected: suite green minus known-flake class.
4. Rebuild local `docuridge` container; report.

## Plan Self-Review

- Spec coverage: roadmap Phase 1 items 1–5 ↔ W5, W1, W2, W3, W4. Identity
  model decision (dual-mode) embedded in W5 (JIT link + personal untouched).
- No placeholders; every workstream lists owned files, produced interfaces,
  and acceptance criteria. W2/W3 page.tsx contention resolved via
  orchestrator integration step.
- Type consistency: `hashAccessCode`/`verifyAccessCode` (W1) consumed only
  within W1; audit event name `envelope.corrected` consistent across W2;
  `Recipient.accessCodeHash` matches applied migration.
