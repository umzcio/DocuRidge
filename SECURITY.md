# DocuRidge — Security Model & Threat Model

This document describes the assets DocuRidge protects, the threats v1 mitigates, and the threats v1 explicitly defers to a production deployment phase. It is the source of truth for security decisions during the build.

---

## 1. Assets

| Asset | What | Why it matters |
|---|---|---|
| User credentials | Email + password hash (Argon2id) | Account takeover → impersonate sender, void or sign envelopes |
| Session tokens | Server-side session ID in httpOnly cookie | Hijack → full account access for session lifetime |
| Signing tokens | Per-recipient JWS, newest-token-wins, time-bounded | Forge → sign in someone else's name |
| Org signing key | Ed25519 private key for the audit chain | Forge → fabricate audit events, undermine non-repudiation |
| Document content | Uploaded PDFs, possibly contracts, employment docs, etc. | Confidentiality + integrity (must not be tampered post-sign) |
| Field values | What the signer typed/drew | Same — these are part of the legally-meaningful record |
| Audit chain | Hash-chained, signed log of every state change | Tampering breaks non-repudiation; this is the legal evidence |
| Sealed PDF | Final signed document with stamps + manifest | Distributed externally; integrity must be verifiable |
| PII | Names, emails, IPs, user agents in audit log | Subject to org data-handling policy and applicable regulations (GDPR / FERPA / HIPAA) |

---

## 2. Trust boundaries

```
[Internet]
    │ TLS terminated at nginx
    ▼
[nginx proxy]            ← TRUST BOUNDARY: anything past here is internal
    │ X-Forwarded-* headers
    ▼
[docuridge_app: Next.js]  ← TRUST BOUNDARY: framework input parsing (Zod)
    │ Prisma over private network
    ▼
[docuridge_postgres]
    │ SMTP via MailHog (dev) or external SMTP relay (production)
    ▼
[docuridge_mailhog | external SMTP relay]
```

Authenticated user sessions vs. unauthenticated signing-token sessions are *different* trust contexts. Signing tokens grant resource-scoped access (one envelope, one recipient, one window of time) — never general account access.

---

## 3. Threats v1 mitigates

### 3.1 Authentication threats

**Credential stuffing / brute force**
- Argon2id with appropriate memory/time/parallelism (`m=64MB, t=3, p=1` baseline; tuned per host)
- Account lockout after N failed login attempts within a window (default `5 / 15min`); lockout audited
- In-process token-bucket rate limit on `/login`, `/register`, `/password-reset`
- Generic error messages on failed login (no account-existence oracle)

**Session hijacking**
- httpOnly + Secure (via `X-Forwarded-Proto`) + SameSite=Lax cookies
- Path scoped to `/DocuRidge` so cookies don't leak to other apps on the same domain
- Server-side session store (DB-backed); sessions invalidatable on password change, lockout, or admin action
- Session ID is a CSPRNG random, indistinguishable from random tokens; not a JWT

**CSRF**
- SameSite=Lax cookies
- Origin/Referer check on all state-changing routes — validated against `PUBLIC_URL`'s origin, not the `Host` header
- Server Actions in Next.js include built-in CSRF protection; we *verify* the framework's defense is enabled rather than rolling our own
- Tested explicitly in Playwright with cross-origin POSTs

**Email-based account-takeover (verification, password reset)**
- Email verification token: signed JWS, time-bounded (24h), single-use, bound to user ID + email
- Password-reset token: same structure, shorter TTL (1h), single-use, invalidates all existing sessions on consumption
- Tokens stored hashed in DB so a DB read doesn't expose live tokens

### 3.2 Authorization threats (IDOR, privilege escalation)

- Centralized `can(user, action, resource)`; no inline role checks
- Every Server Action and route handler calls `can()` before mutating state or returning a resource
- Every resource lookup is org-scoped (`where: { id, orgId: user.orgId }`); Prisma queries never trust client-supplied org IDs
- Tests cover: cross-org access (denied), wrong-role access (denied), draft-envelope access by viewer (denied), signing tokens for wrong recipient (denied)
- **SSO issuer binding:** SSO takes the IdP's email claim as proof of mailbox ownership, and open registration makes every new user an admin of their own org. A deployment-wide list of trusted issuers would let any of them save a trusted IdP with their own client registration and capture its users: new staff provisioned into their org, unverified registrations reclaimed into it. So `SSO_TRUSTED_ISSUERS` holds operator-set bindings, comma-separated `<org-slug>=<issuer-url>` entries (exact match, one per slug). A malformed entry stops the app from starting (`src/lib/env.ts`), and the parser drops it anyway (`src/lib/auth/sso-bindings.ts`). Only the bound org may save the issuer in admin SSO settings. The binding is checked again at use time: the login page and `/api/auth/sso/login` only offer bound, enabled orgs and pick one by `org=<slug>`, never by creation order; the state cookie carries the org's slug and issuer and the callback requires both to match a current binding; `resolveSsoUser` re-reads the org and refuses to provision into an unbound one.

### 3.3 Injection (SQLi, XSS, SSRF, command injection)

- **SQLi:** Prisma parameterizes everything; no raw SQL except in the verify command (which uses parameterized queries on read-only audit data)
- **XSS:** React escapes by default; no `dangerouslySetInnerHTML` in committed code; PDF text rendered as text, never injected as HTML; email templates plain-text + minimal HTML with escaped substitutions
- **SSRF:** Outbound HTTP to a URL a user or org admin configured goes through `src/lib/net/outbound.ts` (`guardedFetch`). Today that means webhook receivers and the per-org SSO issuer, plus the token and userinfo endpoints the issuer's metadata names. Open registration makes every new user an admin of their own org, so treat these URLs as attacker-chosen. The guard:
  - refuses names that only resolve inside a network: single-label names, a trailing dot (`svc.`), underscores (every compose container and network name), and `.local`, `.internal`, `.lan` and `.home.arpa`;
  - resolves the host and refuses if **any** A/AAAA answer is loopback, RFC 1918, CGNAT `100.64/10`, link-local/metadata `169.254/16`, unspecified, multicast or reserved, or an IPv6 ULA (`fc00::/7`), link-local (`fe80::/10`), or anything outside `2000::/3`;
  - parses IPv6 to 128 bits, so IPv4-mapped (`::ffff:7f00:1`), IPv4-compatible, NAT64 and 6to4 forms are judged by the IPv4 address they embed;
  - connects only to the vetted addresses through a pinned `lookup`, so DNS rebinding between the check and the connect cannot move the target, and it never follows redirects.

  Webhooks and the SSO issuer are vetted when they are saved and again on every request. `WEBHOOK_ALLOWED_INTERNAL_HOSTS` and `SSO_ALLOWED_INTERNAL_HOSTS` exempt named hosts on purpose; exempt hosts are still pinned. The AI provider (`DOCURIDGE_AI_BASE_URL`) and SMTP host are operator-set env values and are not guarded.
- **Command injection:** No shell-outs to untrusted input; the verify command takes an argv path validated to live within the sealed-PDF storage directory

### 3.4 Signing-token threats

- Signed JWS (`jose`), HS256 with a per-deploy secret OR Ed25519 with the org key (TBD in Phase 4 — for v1 stability we use a HS256 secret rotated independently from the org key; the chain-signing key stays specialized)
- Claims: `envelopeId`, `recipientId`, `iat`, `exp` (default 14 days, configurable), `jti`
- Newest-token-wins pinning: every mint site pins `jti` on the recipient row immediately, so the most recently issued token is the only valid one and every earlier token for that recipient is refused. That is what makes a reassigned recipient's old invite, or a link superseded by a reminder, stop working. The pinned token itself is NOT consumed by use — it stays valid across repeated requests (the signing ceremony needs many) until the recipient signs, declines, is skipped, or the token expires
- Bound to recipient: token holders can ONLY interact with the envelope and recipient pair encoded; cannot read other recipients' fields
- Rate-limited per-token: hammering a stolen token to brute-force fields is throttled
- Document state-aware: tokens for completed/voided/expired envelopes refuse signing
- Tested negatively: tampered signature, expired exp, replayed jti, wrong recipient, wrong envelope
- **Residual risk**: the emailed link is a bearer credential for its whole TTL (default 14 days, `src/lib/signing/token.ts` `ttlSeconds`) — a forwarded or leaked email grants signing ability until the recipient acts or the token expires. Mitigations in place: JWS signature, envelope + recipient binding, `exp`, `currentTokenExpiresAt`, sequential turn checks, and status gating (`signingStatus` / envelope status) — none of them shorten the window a leaked link stays usable within that TTL

### 3.5 File-upload threats

- MIME sniff (magic bytes), not just `Content-Type` header
- Hard size limit enforced before disk write (configurable, default 25 MB)
- Hard ceilings on decoded stream size (`PDF_MAX_DECODED_STREAM_BYTES`, default 64 MiB per stream; `PDF_MAX_DECODED_TOTAL_BYTES`, default 256 MiB per parse or seal step), enforced inside pdf-lib's decoder (`src/lib/pdf/decode-limits.ts`). Uploads decode every page's `/Contents` under the same ceilings, so a nested-FlateDecode bomb in an `/ObjStm`, `/XRef` or page content stream is rejected at upload (`pdf_too_complex`); sealing and `npm run verify` re-apply them.
- Filename sanitized; storage uses content-hash filenames, not user-supplied names
- Stored under `/data/uploads/<org_id>/<sha256>.pdf`; org-scoped path enforced
- Hash recorded at upload; verified before sealing
- Virus scan extension point (`scanFile(buffer)`) — no-op in v1, ClamAV documented
- Signature, initials, DRAWING and STAMP images: PNG/JPEG magic bytes, a 2 MB encoded cap (`MAX_SIGNATURE_IMAGE_BYTES`), and a ceiling on the dimensions declared in the PNG IHDR / JPEG SOF header (`MAX_IMAGE_DIMENSION`, default 4096 px per side; `MAX_IMAGE_PIXELS`, default 8 MP). A PNG's image data must inflate to no more than its declared size, and animated PNGs are refused. The same check runs at submission and again in the sealer just before `embedPng`/`embedJpg`; an image that fails at seal time is skipped and logged, not decoded.

### 3.6 Audit-chain tampering

- Each event includes `prev_hash` (SHA-256 of prior event's canonical serialization)
- Each event signed with org Ed25519 private key (Phase 4)
- Chain is append-only at the data layer (no UPDATE or DELETE; enforced by Postgres permissions on the `audit_event` table — the app role has INSERT and SELECT only on that table)
- Verify command re-hashes and re-verifies the chain end-to-end, plus the document hash, plus the embedded JSON manifest
- Org private key never leaves its volume, never logged, never returned by any endpoint
- Tests cover: edit a value → verify fails, delete an event → verify fails, swap two events → verify fails, forge a signature → verify fails

### 3.7 PDF tampering (post-sealing)

- Document hash recorded in the audit chain at upload AND at seal
- Sealed PDF embeds a signed JSON manifest as a PDF attachment with the chain head signature
- Verify command re-computes content hash and verifies signatures against an org public key supplied out of band (`--fingerprint` / `--key`, or `DOCURIDGE_VERIFY_FINGERPRINT` / `DOCURIDGE_VERIFY_KEY_FILE`). It never trusts the key embedded in the PDF under test: the manifest's key must match the pinned one (`untrusted_key` otherwise), and with no trust anchor the result is `VERIFY UNTRUSTED — key taken from the document` with exit code 4, never `VERIFY OK`. A sealed PDF re-signed with a fresh Ed25519 key fails. Operators publish the org fingerprint (envelope detail page, completion certificate, `org_signing_key` table) through a channel relying parties already trust.
- The signed manifest's per-page digest (version 2, `src/lib/pdf/content-digest.ts`) covers every object reachable from the page: inherited and nested resources, stream dictionaries and bytes, annotations and appearance streams, all page boxes and `/Rotate`, and render-affecting catalog entries. Digest version 1 (seals made before version 2) covered only `/Contents` and direct XObject payloads, so edits to nested images, fonts, annotations, `/CropBox` or a form `/Matrix` went undetected; `verify` still accepts version 1 for old seals but labels the result `LEGACY DIGEST (v1)`, and `--strict` rejects it. A version 1 manifest (no `sealedContent`) binds no page content at all, so one lifted from any genuine old PDF onto a forged body would pass; `verify` reports it as `VERIFY INCOMPLETE — LEGACY MANIFEST (v1)` with exit code 5 even against a pinned key, exits 0 only with an explicit `--allow-legacy-manifest`, and `--strict` rejects it (`sealed_content_missing`). Tests: `src/lib/verify/sealed-pdf.test.ts`, CLI exit codes in `src/lib/verify/trust.test.ts`.
- PAdES-style PDF signing attempted (Phase 4) for Adobe Reader's native trust UI; if shipped, tampering shows in Adobe directly. If deferred, the verify command is the canonical integrity check.

### 3.8 Email recipient safety (allowlist)

- `MAIL_BACKEND=smtp_relay` mode: every recipient email passes through `isAllowedRecipient()` at the send pipeline (not just at config time)
- Allowed addresses configured via `MAIL_ALLOWLIST` env var (comma-separated). Empty list → nothing sends, even with a valid backend configured.
- Refusal: log structured warning, do NOT send, throw in non-production
- Allowlist function has its own dedicated unit-test suite, independent of integration tests
- Removal procedure documented in `DEPLOYMENT.md`; involves an env flag AND removing the gate function in the same commit (no flag-only override)

### 3.9 Secrets management

- All secrets in env vars, loaded once at startup; never logged (Pino redaction list configured)
- Org Ed25519 private key generated on first boot, written to `/data/keys/org_signing_ed25519.key` with `0600` permissions
- Key file lives in a dedicated Docker volume; never on a host bind mount
- Bootstrap token (one-time) ditto: ephemeral, written to `.env`, used once, can be deleted after first admin password set
- `/setup` accepts only the `BOOTSTRAP_TOKEN` the app is running with now. It does not accept the token from first boot. While setup is pending, the entrypoint also re-syncs `bootstrap_state.tokenHash` to the current token on every boot. Rotating the value (`npm run bootstrap-token`, put it in `.env`, recreate the container) therefore revokes the old token at once. Once setup is complete the token no longer matters.
- If `BOOTSTRAP_TOKEN` is blank and the entrypoint cannot write `.env` (the default image: `/app` is root-owned), the generated token exists only inside the process. It changes on every boot and nobody can read it. Set `BOOTSTRAP_TOKEN` yourself in `.env` before you run `/setup`.
- No secret is ever returned by an API endpoint or rendered to a client view

#### 3.9.1 Secrets baked into images built before the `.dockerignore` fix

- **What happened**: the repository had no `.dockerignore`, so `COPY . .` in the
  build stage copied the build host's real `.env` into the build context.
  Next's `standalone` output then included that `.env`, and the runtime stage
  copied the whole standalone tree into the final image — so any image built
  before this fix carries a plaintext `/app/.env` holding the build host's live
  secrets.
- **Affected secrets**: `SESSION_SECRET`, `JWS_SIGNING_TOKEN_SECRET`,
  `JWS_RESET_TOKEN_SECRET`, `BOOTSTRAP_TOKEN`, `POSTGRES_PASSWORD`, and the
  credentials embedded in `DATABASE_URL`.
- **Whether this is a disclosure depends on where the image went.** The baked
  file grants no access that image access does not already imply, so the
  question to answer is who could read the image but not the build host:
  - **Rotate** if a pre-fix image was ever pushed to a registry, `docker save`d
    and moved, exported into a backup that is read by a wider audience, or built
    in CI (build logs and layer caches usually outlive the run and are often
    readable by more people than the server is). Rotate, rebuild, then delete or
    re-tag every affected image and purge the registry layer cache — deleting the
    image alone does not un-disclose what was already pulled.
  - **Rotation is optional** if the image only ever existed in the build host's
    local Docker daemon. Anyone who can read `/app/.env` out of it needs Docker
    access to that host, and can already read the `.env` on disk directly, so
    rotating buys nothing on its own. Confirm with
    `docker image ls` (no registry-namespaced tag) and by checking that no CI
    pipeline builds the image. Prioritize the filesystem permissions on the real
    `.env` instead — it should be mode `600`, not world-readable.
  - Either way, rebuild once this fix is in place so the image becomes safe to
    distribute later without having to remember this caveat.
- **Blast radius per rotation**, when rotation is warranted, so an operator can
  sequence it:
  - `JWS_SIGNING_TOKEN_SECRET` — invalidates every outstanding signing link;
    in-flight recipients need a fresh invite. Rotate in a quiet window.
  - `JWS_RESET_TOKEN_SECRET` — invalidates outstanding password-reset and
    email-verification links. Low impact.
  - `BOOTSTRAP_TOKEN` — only matters before `/setup` is completed. Rotating it and recreating the container revokes the old value even while setup is pending (§3.9).
  - `POSTGRES_PASSWORD` / `DATABASE_URL` — change in Postgres and in the
    environment together.
  - `SESSION_SECRET` — harmless to rotate; see below.
- **Not affected**: user sessions. `src/lib/auth/session.ts:27` mints session
  IDs with `randomBase64Url(32)` stored server-side; they are not signed with
  `SESSION_SECRET`. The org Ed25519 signing key is also unaffected — it lives
  on the `/data` volume (`Dockerfile:61-62`, `src/lib/crypto/org-key.ts:95-98`),
  never in the image.
- **Fix**: `.dockerignore` now excludes `.env` (and all `.env.*` variants) from
  the build context, and the runtime stage runs `rm -f /app/.env ...` as
  defense in depth. The logger no longer requires the full validated env
  (§3.10 unaffected — `LOG_LEVEL` and `NODE_ENV` are read directly), which is
  what let a populated `.env` be removed from the build context without
  breaking `next build`.

### 3.10 Logging hygiene

- Pino redaction list: `password`, `*.password`, `*.passwordHash`, `token`, `*.token`, `cookie`, `authorization`, `secret`, `signingKey`, `*.privateKey`, `bootstrapToken`
- Audit events log structured fields, never the raw resource (no PDF bytes, no full field values for sensitive types)
- IP and user-agent intentionally logged in audit events (legal record); password and token values are not

### 3.11 Rate limiting

- Token bucket per IP on auth endpoints, per token on signing endpoints, per user on bulk-send job creation
- Returns 429 with `Retry-After` header
- Counted in audit log when an endpoint is throttled, so attack patterns are visible

### 3.12 Headers / framework defaults

- `Content-Security-Policy`: strict; `script-src 'self'` only (Next App Router supports nonce-based inline if needed); `frame-ancestors 'none'`; `object-src 'none'`
- `Strict-Transport-Security`: set by nginx (terminates TLS); app does not need to emit it
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`
- Cookie flags as in §3.1

---

## 4. Threats v1 EXPLICITLY DEFERS

These are real threats. v1 does not address them. Production deployment must address them.

| Deferred threat | What it would take | Tracked in |
|---|---|---|
| SAML / CAS SSO, SSO-only mode | Auth strategy interface; SP metadata; `AUTH_STRATEGY=sso_only` | Per-org OIDC ships (bound via `SSO_TRUSTED_ISSUERS`, §3.2); see DEPLOYMENT.md §4 |
| KBA / ID verification | Third-party integration (e.g., Persona, ID.me) | Out of v1 scope |
| Notary / RON | Significant feature surface + state-by-state legal review | Out of v1 scope |
| Qualified Electronic Signatures (eIDAS QES) | Hardware crypto, qualified trust service provider | AES is the v1 ceiling |
| Cloud KMS / HSM integration | Provider SDK; key import flow | Local key file for v1, upgrade path documented |
| Audit-chain externalization (e.g., to a public ledger or shared archive) | Configurable sink; tamper-evident archival | Out of v1 scope; v1 chain is locally verifiable |
| Multi-tenancy beyond a single org | Org-switching UI, per-org branding, user-org join model | Schema is org-scoped but no UI |
| Real CA-issued PAdES certificate | Procurement; rotation; CRL/OCSP | Self-signed if PAdES ships at all in v1 |
| Backup / restore tooling | `pg_dump` + key + uploads volume rotation | Documented in OPERATIONS.md but not automated |
| Centralized observability (OpenTelemetry, Sentry, Loki) | Exporter config; instrumentation | Hooks documented; not wired |
| WAF / DDoS protection | Layer-7 in front of nginx | Infrastructure problem, not app |
| Subresource Integrity / dependency pinning policy | npm audit signing, supply chain controls | Documented as a gap |

---

## 5. Threats per OWASP Top 10 (2021 / 2025-aligned)

| Category | v1 mitigation |
|---|---|
| A01 Broken access control | Centralized `can()`; org-scoped queries; signing tokens scoped to (envelope, recipient) |
| A02 Cryptographic failures | Argon2id; Ed25519 audit signing; httpOnly Secure SameSite cookies; TLS at proxy; secrets only in env + locked-down volume |
| A03 Injection | Prisma parameterization; React escaping; validated argv in verify command |
| A04 Insecure design | Threat-model-first build; this document; review at each phase exit |
| A05 Security misconfiguration | Hardened CSP; Pino redaction; default ports configurable; strict TS |
| A06 Vulnerable / outdated components | Lockfile committed; deps pinned; `npm audit` in CI; documented review cadence |
| A07 ID and authn failures | Argon2id; lockout; rate-limited auth; generic error messages; verified email; bounded reset tokens |
| A08 Software and data integrity | Audit chain; signed sealed-PDF manifest; verify command; document hash recorded twice (upload, seal) |
| A09 Logging / monitoring | Structured Pino; per-request ID; user/action/resource fields; audit chain as legal evidence; `/healthz` `/readyz` |
| A10 SSRF | User/admin-configured URLs go through `guardedFetch`: resolve, refuse any non-public answer, pin the connection, no redirects (§3.3) |

---

## 6. Specific bug classes called out

- **CSRF on Server Actions**: framework defense verified, not assumed.
- **XSS via PDF text fields**: field values rendered as React text nodes only, never as `dangerouslySetInnerHTML`. PDF stamping uses pdf-lib's text APIs (no eval, no template injection).
- **IDOR on signing tokens**: token's `recipientId` MUST match the request's resource lookup. Tested.
- **Session fixation**: session ID rotated on login.
- **Open redirect**: redirect targets validated against an allowlist of internal paths; no user-supplied absolute URLs.
- **Timing attacks on token comparison**: constant-time compare for bootstrap token, JWS signatures (handled by `jose`), and any string equality on auth values.
- **Mass assignment**: every Prisma create/update receives an explicit field whitelist; no `Object.assign(model, body)`.
- **PDF parsing DoS**: pdf-lib inflates compressed streams synchronously with no limit of its own. DocuRidge caps the encoded upload size and the decoded size of every stream and of each document parse (see §3.5); a PDF that exceeds them is rejected with a validation error, not a hang. There is no wall-clock parse timeout: work up to the ceilings still runs on the request's event loop.

---

## 7. Production prerequisites (handed off to UM)

These must be in place before the app handles real signatures:

1. **SSO via CAS / Shibboleth** — auth strategy swap; gate the email-password path with `AUTH_STRATEGY=sso_only` or similar.
2. **Real TLS cert on nginx** — already terminated at proxy; ensure cert is current and CA-issued.
3. **Backup strategy** — `pg_dump` cron, key file replicated to a secondary location, uploads volume snapshot.
4. **Allowlist removal** — env flag flipped + gate function removed in the same commit; documented in DEPLOYMENT.md.
5. **Org signing key custody** — decide if the key stays on this host or moves to a KMS/HSM; document key-rotation procedure.
6. **Observability** — Sentry or equivalent for error tracking; Loki/CloudWatch for log aggregation; metrics endpoint for Prometheus.
7. **Rate-limiter promotion** — Redis-backed if more than one app instance.
8. **Pen test or formal security review** — third-party.
9. **Legal review** — UETA/ESIGN consent text, audit-trail format meets evidence standards, retention policy.

---

## 8. Verification

The build's security claims are verifiable:

- Authn / authz / token / mailer / audit code paths have unit tests covering both happy and adversarial inputs.
- Playwright end-to-end tests cover negative flows (cross-org access, expired tokens, etc.).
- `npm run verify -- --fingerprint <org key fingerprint> <sealed.pdf>` reproduces the cryptographic chain check against a pinned org key.
- Threat → mitigation → test mapping is grep-able: each test names the threat it covers in its description.

If a row in §3 cannot be tied to at least one test, that row is not yet shipped.
