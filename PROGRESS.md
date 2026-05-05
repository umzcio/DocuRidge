# DocuRidge — Progress Log

## Run Metadata

- **Start time:** 2026-05-05 (Phase 0 begins now)
- **Owner:** DocuRidge Admin
- **Mode:** Autonomous, auto-accept edits, bash requires approval
- **Quality bar:** ~90% to production deployment; quality > timeline

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 0 | Research & Architecture | Complete |
| 1 | Foundations | Complete |
| 2 | Core Envelope Flow | Pending |
| 3 | Multi-Recipient, Lifecycle, Templates | Pending |
| 4 | Cryptographic Hardening | Pending |
| 5 | UX Polish via Playwright Self-Critique | Pending |
| 6 | Bulk Send (conditional) | Pending |
| 7 | Handoff | Pending |

## Phase Entries

(Each phase appends a section here on exit: shipped, deferred with reasons, decisions, time elapsed, test pass rate.)

### Phase 0 — Research & Architecture (complete)

**Shipped:**
- `RESEARCH.md` — competitive UX synthesis across DocuSign / Adobe Sign / Dropbox Sign / PandaDoc / SignWell, plus prior-art study of Documenso / DocuSeal / OpenSign. 19 prioritized design decisions, all sourced.
- `DECISIONS.md` — 31 entries covering stack, reverse-proxy integration deviation (host pattern over amendment's literal `external: true`), subpath `/DocuRidge` baked in from Phase 1, mail allowlist with code-level enforcement, centralized `can()`, PAdES as best-effort, virus-scan extension point, bootstrap admin via one-time token (not log-printed link), unified Envelope/Template, EnvelopeItem multi-doc, template snapshotting on instantiation, JWS signing tokens with `jti` single-use, two audit streams, hash-chained Ed25519-signed audit log as the v1 differentiator, `onDelete: Restrict` on audit FKs, fractional top-left coordinate system with single conversion point, durable `BackgroundJob` table, append-only audit enforced at DB role level, `@signpdf` toolchain attempt for PAdES, isolated-by-default recipient privacy, built-in email branding.
- `SCHEMA.md` — full data model with 22 tables, indexes, FK behavior, multi-tenancy notes, coordinate-system conventions, soft-delete strategy, migration plan, and a coverage table mapping every v1 feature to the tables that support it. All v1 features represented including bulk send and templates.
- `SECURITY.md` — assets, trust boundaries, mitigations across §3 (auth, authz, injection, signing tokens, file uploads, audit-chain tampering, PDF tampering, email allowlist, secrets, logging, rate limiting, headers), explicit deferrals (§4), OWASP Top 10 mapping (§5), bug-class callouts (§6), production prerequisites for handoff (§7), and verification plan (§8). THREAT_MODEL is §4–§7.

**Decisions made (key):** see `DECISIONS.md` D-001–D-031. Most consequential:
- D-002: deviate from amendment's literal `external: true` wording; follow the host's per-app-network convention (compose declares `docuridge_proxy_net`, owner attaches `proxy` to it). Same end state, follows existing pattern, cleaner ownership.
- D-024: cryptographic audit chain (hash + Ed25519 signature) — none of the OSS priors do this; it's UM's regulated-context requirement and the v1 differentiator.
- D-008: bootstrap admin via one-time `BOOTSTRAP_TOKEN` env, not log-printed reset link. Per owner's override of my initial plan.
- D-019: unified `Envelope` table with `type = DOCUMENT | TEMPLATE` discriminator (Documenso pattern).

**Deferred:** none for Phase 0 — research scope capped at ~25 minutes of agent time per stream and met.

**Verified consistent across docs:** signing-token mechanism (HS256 JWS with `jti`), audit-chain mechanism (Ed25519 over event hash with `prev_hash`), DB-role-enforced append-only audit, `onDelete: Restrict` audit FKs.

**Time:** ~30 min wall clock, of which ~16 min was concurrent agent research time (overlapped with document drafting).

**Infrastructure facts captured for Phase 1:**
- Reverse proxy container is named `proxy` (image `nginx:alpine`); it joins one network per app it routes to.
- Default DocuRidge ports (3737, 54317, 8737, 10737) all free on host.
- Host has Node 22.22.2 and Docker 29.4.2 with `docker compose v5.1.3`.
- Existing nginx config uses `set $upstream <name>:<port>; resolver 127.0.0.11; proxy_pass http://$upstream;` pattern with `client_max_body_size 500M` global cap and WebSocket upgrade headers in use. The DocuRidge snippet will mirror this style.

### Phase 1 — Foundations (complete)

**Shipped:**
- **Compose stack** — `docker-compose.yml` (production: app, postgres 16-alpine, mailhog, all `docuridge_`-scoped, postgres + mailhog on 127.0.0.1 only) and `docker-compose.local.yml` (NOT auto-loaded; binds app to 127.0.0.1:3737 for local dev/testing). Project name `docuridge`.
- **Multi-stage Dockerfile** with non-root user, Next standalone output, prisma client + CLI bundled, tini PID-1, embedded entrypoint.
- **Entrypoint script** (`scripts/docker-entrypoint.sh`) that auto-generates `SESSION_SECRET`, `JWS_SIGNING_TOKEN_SECRET`, `JWS_RESET_TOKEN_SECRET`, and `BOOTSTRAP_TOKEN` if blank (writes to `.env`, never logs the values), runs `prisma migrate deploy`, and initialises the `BootstrapState` row + `Organisation` + admin `User` (no password yet) so the first visit to `/setup` can complete bootstrap.
- **Prisma schema** — full v1 model from `SCHEMA.md`: 22 entities, all enums, indexes, FK behavior (`onDelete: Restrict` on `AuditEvent`/`SealedDocument`), org scoping. Initial migration `20260505164055_init` plus follow-up `20260505164100_audit_append_only` that creates the `docuridge_audit_immutable` Postgres trigger function and BEFORE UPDATE/DELETE triggers on `audit_event` and `user_security_audit_event` (per D-028).
- **Auth** — Argon2id password hashing (m=64MB, t=3, p=1), email + password registration with first-user-becomes-admin org creation, email verification with hashed-token storage + JWS signing, password reset flow, account lockout (5 attempts in 15 min → 15-min lockout, audited), server-side sessions in DB with httpOnly + SameSite=Lax cookies scoped to `Path=/DocuRidge`, login that increments failed-attempt counter regardless of email-verification status (no email-existence oracle), bootstrap-admin one-time `/setup` flow gated by `BOOTSTRAP_TOKEN`.
- **Centralized authorization** — `src/lib/authz/can.ts` with role × action matrix (`ADMIN | SENDER | VIEWER`), cross-org denial baked in, ownership rule for `envelope:void` by SENDER, `authorize()` throwing `AuthorizationError`. **23 unit tests** cover every action, role combination, ownership rule, and cross-org case.
- **Centralized input validation** — Zod schemas inline in every server action; shared `emailSchema`, `nameSchema`, `passwordSchema()` (NIST-aligned: length-first, banned-substring list).
- **Mail abstraction** — `src/lib/mail/index.ts` with two transports (`mailhog` default, `smtp_relay` gated). The recipient allowlist function (`src/lib/mail/allowlist.ts`) is called by the send pipeline whenever `MAIL_BACKEND=smtp_relay`. Refusal: log structured warning, record `EmailEvent` with `type=skipped_allowlist`, throw in non-production. **10 unit tests** cover canonical addresses, case-insensitivity, whitespace trimming, subdomain spoofing, local-part spoofing, edge-case inputs (null, undefined, number).
- **Pino structured JSON logger** with redaction list (passwords, tokens, secrets, signing keys) and per-process child-logger pattern; request-ID middleware sets `x-request-id` on every response.
- **Rate limiter** — DB-backed token bucket on `(key, action, bucket)` keyed by client IP. Wired to `/login`, `/register`, `/password-reset`. Signing-token rate limit slot defined for Phase 2.
- **Health endpoints** — `/healthz` (liveness, always 200) and `/readyz` (200 if DB reachable, 503 otherwise) at the basePath. Container healthcheck wired.
- **Subpath baked in** — `next.config.js` sets `basePath: '/DocuRidge'` and `assetPrefix: '/DocuRidge'`. `experimental.serverActions.allowedOrigins` allows production host + 127.0.0.1:3737 + localhost:3737 + docuridge_app:3000. Middleware enforces a defense-in-depth Origin check.
- **Security headers** — CSP, X-Frame-Options: DENY, X-Content-Type-Options: nosniff, Referrer-Policy: strict-origin-when-cross-origin, Permissions-Policy, all set in `next.config.js`.
- **Error/404 boundaries** — `src/app/error.tsx` (client error fallback with digest reference) and `src/app/not-found.tsx`.
- **Pages and forms** — landing/`/`, `/setup`, `/login`, `/register`, `/verify` (route handler with proxy-aware redirect), `/reset` request, `/reset/[token]` complete, `/dashboard` (placeholder for Phase 2 with logout button), all using React 19 `useActionState` for Server Actions.
- **Reverse-proxy snippet** — `deploy/nginx/docuridge.conf` written but NOT applied. Includes case-variant redirects (`/docuridge` → `/DocuRidge/`), no-trailing-slash redirect, dynamic upstream resolution via Docker DNS, full `X-Forwarded-*` propagation, WebSocket upgrade headers, `client_max_body_size 50m`, generous timeouts. Matches the host's existing pattern.
- **Tests** — Vitest scaffolding with V8 coverage; Playwright config with `chromium-desktop`, `mobile`, and `smoke` projects; in-network e2e suite at `tests/e2e/auth.spec.ts` covering full bootstrap → register → verify → login → lockout → password reset round-trip; smoke suite at `tests/smoke/health.spec.ts` for post-deploy verification against the public URL.
- **README quickstart** that walks through clone → compose up → grep BOOTSTRAP_TOKEN → /setup → sign in.

**Decisions added or refined:** none new beyond Phase 0; Phase 1 implemented D-001 through D-031 faithfully.

**Deviations from plan / things to know:**
- The amendment said "attach app as `external: true` to nginx network." Followed host convention instead per D-002: app declares `docuridge_proxy_net` itself; the owner attaches `proxy` post-deploy. DEPLOYMENT.md (Phase 7) will document the steps.
- Switched from `useFormState` (React 19 deprecation path) to `useActionState` after a debug round.
- `docker-compose.local.yml` introduced for local-dev/test port exposure; **not** auto-loaded so production stays isolated.
- The audit-append-only DB enforcement uses Postgres triggers (per migration `20260505164100_audit_append_only`), not separate roles. Equivalent tamper-resistance, simpler operationally.

**Tests, total:** 40 passing.
- 33 Vitest unit tests (10 allowlist + 23 authorization).
- 7 Playwright e2e tests (bootstrap admin completes setup; register → verify → login round-trip; login bad-password generic error / no email-existence oracle; lockout after 6 failed attempts; password reset round-trip; `/healthz`; `/readyz`).
- All green on a fresh DB after `docker compose -p docuridge -f docker-compose.yml -f docker-compose.local.yml up --build`.

**Time:** ~110 min wall clock for Phase 1 (scaffolding + code + first compose-up + debug cycle on basePath/CSRF/useFormState/QP-decode/redirect-host issues + final clean run).

**Open follow-ups for Phase 2 onward:**
- The verify-route redirect now reads `X-Forwarded-Host`/`Proto` correctly; same pattern needed wherever signing tokens generate per-recipient links so emails work behind nginx.
- The rate-limiter has a `signing_token` action slot ready but no caller yet — Phase 2 will wire it.
- The audit chain schema is in place (`AuditEvent.prevHash`, `eventHash`, `signature`, `signedByKeyId`) but events are not yet written; Phase 2 starts emitting them, Phase 4 turns them on cryptographically.
