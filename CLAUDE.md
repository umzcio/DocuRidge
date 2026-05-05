# Project: DocuRidge — Self-Hosted E-Signature Platform

## Mission

Build a **production-ready v1** of a self-hosted DocuSign/Adobe Sign replacement, fully containerized. The bar is 90% of the way to a real Acme Org production deployment — the remaining 10% is integration work (SSO wiring, infra hardening, load testing, formal security review), not rewrites.

This is **not a prototype**. Every shipped feature must be built the way you'd want it in production: real validation, real error handling, real authorization checks, real audit logging, real tests. Where a feature is intentionally deferred, it must be deferred *cleanly* — schema in place, extension point documented, no half-built code left behind.

The owner is DocuRidge Admin, CIO at the Acme Org. He is running you in autonomous mode with auto-accept edits enabled but **not** `--dangerously-skip-permissions`. He will be away for ~2 hours but timeline is not the constraint — quality is. If a phase needs more time to ship correctly, take it. Better to ship 4 phases at production quality than 6 at prototype quality.

## Operating Mode

- You are running autonomously. Do not stop to ask clarifying questions unless you hit a true blocker. Pick the reasonable default, log it in `DECISIONS.md` with rationale, continue.
- Auto-accept is on for file edits. **Bash commands still require approval.** Batch your bash work — don't fragment a setup into 40 sequential prompts when 3 well-formed scripts will do. But don't chain destructive things together to "save prompts" either. One prompt per logical unit of work.
- True blockers (write to `BLOCKERS.md`, work around if possible, continue): missing system credential the owner must provide, hardware/environment failure, security or legal question with no defensible default.
- Genuine ambiguity in product requirements is **not** a blocker. Decide, document, ship.

## Hard Constraints — Docker & Environment Isolation

The owner has existing Docker containers, networks, volumes, and configs unrelated to this project. **You must not touch them.**

- All resources in this project are prefixed `docuridge_` (containers, networks, volumes, images)
- Use a dedicated compose project name: `docker compose -p docuridge ...` or set `COMPOSE_PROJECT_NAME=docuridge` in `.env`
- **Never run** `docker system prune`, `docker volume prune`, `docker network prune`, `docker container prune`, or any unscoped `docker rm` / `docker stop`
- Never stop, restart, or modify a container you didn't create in this run
- Never modify the user's global Docker daemon config, `~/.docker/`, or any system-level Docker state
- All ports must be configurable via `.env` and default to non-common values to avoid conflicts: app `3737`, postgres `54317`, mailhog UI `8737`, mailhog SMTP `10737`
- Before binding any port, check it's free; if not, increment and document
- All persistent data lives in named volumes scoped to this project, never in bind mounts to arbitrary host paths

If you ever feel tempted to run a broad `docker` command to "clean up," stop. Write the concern to `BLOCKERS.md` instead.

## Hard Constraints — Email

external SMTP is `smtp.example.com:25` and is available for real outbound mail when needed. **However:**

- During development and testing, route all mail to MailHog by default
- The application must support both backends via env config: `MAIL_BACKEND=mailhog` (default) or `MAIL_BACKEND=smtp_relay`
- A hard allowlist is enforced **at the mail-sending layer**, not just in tests, whenever `MAIL_BACKEND=smtp_relay`. Allowed recipients:
  - `admin@example.com`
  - `user@example.com`
  - `admin@example.com`
- Any attempt to send to a non-allowlisted address while `MAIL_BACKEND=smtp_relay` must: (1) refuse to send, (2) log a structured warning, (3) raise in non-production environments
- The allowlist is a code-level safety net independent of the test suite. It must be a function called by the mail send pipeline, with its own unit tests.
- Document the allowlist removal procedure in `DEPLOYMENT.md` for when this goes to real production

## Hard Constraints — Production Quality

These apply to every line of code shipped, not just "the important parts":

1. **Authorization on every endpoint.** No endpoint trusts the client to tell it who the user is or what they're allowed to do. Every server action and API route checks: is the caller authenticated, do they have the role/permission for this action, do they own or have access to the resource? Authorization is centralized (a `can(user, action, resource)` function), not scattered.
2. **Input validation at the boundary.** Every request is parsed and validated with Zod (or equivalent) before it touches business logic. Reject early. Never trust client-supplied IDs without an ownership check.
3. **No secrets in code or logs.** All secrets via env vars. Signing keys generated on first boot, persisted to a dedicated volume, never logged, never returned by any endpoint.
4. **Structured logging.** JSON logs with request ID, user ID (when authenticated), action, resource, outcome. No `console.log` in committed code outside the logger module.
5. **Database migrations, not `db push`.** Every schema change is a versioned migration. The compose stack runs migrations on startup.
6. **Real error handling.** No empty catch blocks. No swallowed errors. User-facing errors are sanitized; internal errors are logged with full context. 500s are bugs, not features.
7. **Tests beyond the happy path.** Each feature ships with: a Playwright test for the user flow, unit tests for the business logic and authorization, and at least one negative test (unauthorized access, malformed input, expired token).
8. **CSRF, XSS, SQL injection, IDOR — all handled by default.** Use the framework's built-in protections correctly. Document where you've thought about each in `SECURITY.md`.
9. **Rate limiting on auth and signing endpoints.** In-process token bucket is fine for v1; document the upgrade path to Redis.
10. **Observability hooks.** Health endpoint at `/healthz` (liveness) and `/readyz` (readiness, including DB connectivity). Request timing logged. Error rates trackable. Document the upgrade path to OpenTelemetry.

## Mandatory v1 Scope

These ship in v1, fully production-grade:

1. **Auth & identity:** email + password (Argon2id), email verification, password reset, session management via httpOnly cookies, account lockout after N failed attempts, organization model with roles (admin, sender, viewer)
2. **Document upload & rendering:** PDF upload (size + MIME validated, virus-scan extension point documented), in-browser preview, multi-page navigation
3. **Field placement:** drag-and-drop placement of signature, initial, date, text, checkbox fields across all pages, per-recipient assignment, required/optional flag, prefilled values
4. **Multi-recipient sequential routing:** envelope advances to next recipient only after the prior recipient completes their fields; parallel routing supported as a config (default sequential)
5. **Signing ceremony:** unauthenticated recipient page accessed via signed, single-use, time-bounded token; clear sender identity and document summary; consent to e-sign disclosure (UETA/ESIGN-aware language); signature capture (typed + drawn); explicit final-confirm step
6. **Cryptographic audit trail:** every state-changing action recorded with `{prev_hash, event_data, actor, ip, user_agent, timestamp, signature}`; chain signed with org-level Ed25519 key; tamper detection via verify command
7. **Sealed PDF output:** signature images and field values rendered into the PDF, audit manifest appended as a human-readable final page, machine-readable signed JSON manifest embedded as a PDF attachment, document hash recorded in audit chain
8. **Email notifications:** envelope sent (to first recipient), your turn to sign (to next recipient on advance), envelope completed (to sender + all signers with sealed PDF link), envelope voided/declined; templates render correctly in plain-text and HTML
9. **Templates:** save envelope structure (documents, fields, recipient roles) as reusable template; instantiate envelope from template with role → email mapping
10. **Envelope lifecycle:** draft, sent, in-progress, completed, declined, voided, expired; sender can void in-flight envelopes; recipient can decline with reason
11. **Audit view:** sender sees full per-envelope audit log; downloadable as signed JSON; verifiable via the verify command

## v1 Scope — Last to Ship

12. **Bulk send:** CSV upload → one envelope per row from a chosen template, with per-row field substitution, recipient mapping, and a job-status dashboard. **This ships last** because it multiplies any bug in the core flow. If everything else is rock-solid and time remains, build it. If not, ship the schema + a stub UI marked "coming soon" — clean extension point, no half-built code.

## Architecture Choices Already Made

The owner asked you to choose, but research time is better spent on UX research than on stack research. Use this stack unless you find a deeply compelling reason against it (document the deviation in `DECISIONS.md`):

- **Next.js 15 (App Router) + TypeScript strict** — Server Components + Server Actions for most mutations, route handlers where needed
- **Postgres 16** + **Prisma** with proper migrations
- **Tailwind + shadcn/ui** for components — neutral palette, single accent, no AI-gradient aesthetic
- **pdf-lib** for PDF manipulation and sealing; **react-pdf / pdfjs** for in-browser preview
- **node-signpdf** for PAdES-style PDF signing if feasible; otherwise document the upgrade path and ship the embedded signed manifest
- **Argon2id** for passwords (`argon2` package), **jose** for JWT/JWS, **@noble/ed25519** or Node's `crypto` for the audit chain
- **nodemailer** with two transports: MailHog (dev) and SMTP relay to `smtp.example.com:25` (prod-ish)
- **Playwright** for e2e, **Vitest** for unit/integration
- **Pino** for structured logging
- **Zod** for all input validation

**Out of scope for v1** (build clean extension points, do not implement):

- SSO / SAML / OIDC — but design the auth layer so it's a strategy swap, not a rewrite. operators plug in CAS/Shibboleth.
- KBA / ID verification
- Notary / RON
- Qualified Electronic Signatures (eIDAS QES) — AES is the ceiling for v1
- Native mobile apps (responsive web, tested at 390px, is the target)
- Payments
- Multi-tenancy beyond a single org (schema must be org-scoped, but no org-switching UI)
- Cloud KMS / HSM integration (local key with documented upgrade path)
- White-label theming

## Phase Structure

Each phase ends with a status entry in `PROGRESS.md`: what shipped, what was deferred, decisions made, time elapsed, current test pass rate. Don't move to the next phase until the current one's exit criteria are met. Take the time it needs.

### Phase 0 — Research & Architecture

Research what users actually love and hate about DocuSign, Adobe Sign, Dropbox Sign, PandaDoc, SignWell, and the open-source prior art (DocuSeal, OpenSign, Documenso). Cap research at ~25 minutes — enough to inform decisions, not enough to read everything.

Specifically extract:

- Top complaints (UX friction, mobile signing pain, unclear status, audit gaps, surprise pricing, recipient confusion)
- Top praise (what makes signing feel trustworthy, fast, and final)
- Schema and signing-flow patterns from open-source prior art (study, do not copy code)

Output `RESEARCH.md` with 10–15 prioritized design decisions, each citing the source insight and your chosen direction.

Then produce:

- `DECISIONS.md` — stack confirmation, deviations from defaults, key architectural choices
- `SCHEMA.md` — full data model with relationships, indexes, soft-delete strategy
- `SECURITY.md` — threat model: assets, threats, mitigations, residual risk; explicit treatment of CSRF, XSS, SQLi, IDOR, SSRF, file-upload risks, signing-token theft, audit-chain tampering
- `THREAT_MODEL.md` (can be a section of SECURITY.md) — what v1 protects against, what it explicitly defers, prerequisites for production deployment at UM

**Exit criteria:** all four documents written, reviewed for internal consistency, schema covers every v1 feature including bulk send and templates.

### Phase 1 — Foundations

Build the production-grade foundation. No feature work yet — this phase is about getting the substrate right so feature phases are fast and safe.

- `docker compose` stack: app, postgres, mailhog, all `docuridge_`-scoped, ports from env
- Prisma schema covering the full v1 model; initial migration; seed script structure (data comes later)
- Auth: registration with email verification, login with Argon2id, session cookies, password reset, account lockout, role-based access (`admin`, `sender`, `viewer`); CSRF protection verified
- Centralized authorization: `can(user, action, resource)` with unit tests covering every permission
- Centralized input validation with Zod schemas colocated with each route/action
- Mail abstraction with MailHog and SMTP relay transports; **allowlist function with its own unit tests**; refusal path tested
- Structured logging with Pino; request ID middleware; user/action/resource fields
- Health endpoints: `/healthz`, `/readyz`
- Rate limiting on `/login`, `/register`, `/password-reset`, signing-token endpoints
- Error boundaries, sanitized error responses, internal error logging
- Playwright + Vitest scaffolding; CI-runnable test scripts in `package.json`
- `README.md` quickstart that actually works on a fresh clone

**Exit criteria:** fresh `docker compose -p docuridge up --build` produces a running stack on a clean machine. Auth flow works end-to-end with tests passing — registration, verification, login, password reset, lockout, RBAC denial. Allowlist refusal tested. Health endpoints respond correctly.

### Phase 2 — Core Envelope Flow

The vertical slice, but production-grade.

- PDF upload with size limit, MIME sniffing, hash recorded; virus-scan extension point documented
- In-browser PDF preview with page navigation
- Field placement UI: drag-and-drop signature, initial, date, text, checkbox; per-recipient assignment; required flag; prefill
- Envelope creation: draft → sent transition with full validation
- Signing token generation: signed, single-use, time-bounded, bound to recipient + envelope
- Recipient signing page: identity context, document summary, consent disclosure, field completion, final confirm
- Audit events written for every state change with full context
- Initial sealed PDF generation (signature stamping, field rendering, manifest page)
- Email notifications for: envelope sent, your turn to sign, envelope completed
- Playwright tests for the full happy path **plus** negative tests: expired token, reused token, unauthorized envelope access, malformed field data, oversized PDF, non-PDF upload
- Unit tests for token generation/validation, authorization on envelope endpoints, audit-event creation

**Exit criteria:** a single-recipient envelope can be created, sent, signed, and downloaded as a sealed PDF. All happy-path and negative tests green. Audit log accurate.

### Phase 3 — Multi-Recipient, Lifecycle, Templates

- Sequential routing engine: envelope advances on recipient completion; next recipient notified; tested with 3+ recipients
- Parallel routing supported as an envelope-level config (default sequential)
- Decline flow: recipient can decline with reason; envelope moves to declined; sender notified
- Void flow: sender can void in-progress envelope; recipients notified; audit recorded
- Expiration: envelopes have a default expiration (configurable); expired envelopes transition correctly; expiry job documented (cron extension point)
- Templates: create from envelope, instantiate to envelope with role mapping; permissions enforced
- Sender dashboard: list envelopes by status, filter, search, paginate
- Audit view: per-envelope timeline, downloadable signed JSON
- Tests for every transition, every authorization edge case, multi-recipient sequencing

**Exit criteria:** a 3-recipient sequential envelope flows correctly through send → sign → sign → sign → completed. Decline and void paths tested. Templates round-trip correctly. Dashboard filters/search work.

### Phase 4 — Cryptographic Hardening

- Org signing key generated on first boot (Ed25519), persisted to a dedicated volume, file permissions locked, never logged, never API-exposed
- Audit chain: each event signed, chained via `prev_hash`, verifiable
- Sealed PDF: appended human-readable audit page, embedded signed JSON manifest as PDF attachment, document hash recorded in chain
- Verify command: `docker compose -p docuridge exec app npm run verify -- /path/to/sealed.pdf` — re-checks chain, signature, document hash; exits non-zero on tamper
- If feasible: PAdES-style PDF signing via node-signpdf with a self-signed cert generated on first boot; document the upgrade to a real CA-issued cert in `DEPLOYMENT.md`
- Tests: tamper with the PDF → verify fails. Tamper with an audit event → verify fails. Truncate the chain → verify fails. Forge a signature → verify fails.

**Exit criteria:** every form of tampering the threat model identifies is detected by the verify command. Verify output is unambiguous.

### Phase 5 — UX Polish via Playwright Self-Critique

For each primary view (sender dashboard, envelope builder, signing ceremony, audit view, template manager, settings):

1. Playwright navigates each step, screenshots desktop (1440px) and mobile (390px)
2. Critique each screenshot rigorously: hierarchy, spacing, affordances, empty states, error states, loading states, focus rings, WCAG AA contrast, keyboard navigation, screen-reader landmarks
3. Make targeted fixes; re-screenshot; compare; iterate until the view feels intentional and trustworthy
4. The signing ceremony specifically must communicate trust: clear sender identity, document name, what-you're-agreeing-to summary, audit-trail promise, no sketchy patterns

Every primary view must have: explicit empty state, explicit error state, explicit loading state. Forms must show validation inline, not just on submit. Destructive actions must confirm. Long operations must show progress.

Accessibility is a hard requirement, not a nice-to-have: WCAG AA contrast verified, keyboard-only navigation works for every flow, focus management correct on route changes and modals, ARIA labels on icon-only buttons, form labels associated correctly.

**Exit criteria:** every primary view screenshot-reviewed at desktop and mobile and iterated at least once. Accessibility audit passes (axe or equivalent run in Playwright). Keyboard-only run-through of the signing ceremony succeeds.

### Phase 6 — Bulk Send (only if everything above is solid)

- CSV upload with schema validation against the chosen template
- Per-row preview before submission
- Background job creation per row; job-status dashboard
- Per-recipient email allowlist enforcement (still applies)
- Rate-limited sending to avoid SMTP throttling
- Partial-failure handling: row-level errors surfaced, retry path documented
- Tests: 100-row CSV round-trips correctly; malformed CSVs rejected with clear errors; allowlist refusals counted in the dashboard

**Exit criteria:** a 100-row CSV produces 100 envelopes, all advancing correctly, with a usable status dashboard. Malformed input handled gracefully.

If time runs short before this phase, ship the schema (templates already support it), put the UI behind a "Coming soon" flag, and document the implementation plan in `PROGRESS.md`. Do not ship a half-built version.

### Phase 7 — Handoff

- Realistic seed data: 3 users across 2 roles, 6 envelopes covering every lifecycle state, 3 templates, sample sealed PDF with verifiable chain
- `README.md`: quickstart, architecture overview, demo credentials, how to run tests, how to verify a sealed PDF
- `DEPLOYMENT.md`: prerequisites for production deployment — SSO integration plan (CAS/Shibboleth strategy swap), real cert issuance, secrets management, backup strategy, observability upgrade path, allowlist removal procedure, recommended infra topology
- `SECURITY.md` finalized with what v1 covers and what production requires
- `OPERATIONS.md`: backup, restore, key rotation, common incident playbooks
- `PROGRESS.md` final entry: shipped, deferred (with reasons), known issues, recommended next 5–10 hours of work
- Final test run: Playwright + Vitest, all green; coverage report committed
- Conventional-commit history with one commit per phase minimum

**Exit criteria:** a fresh clone + `docker compose -p docuridge up --build` produces a working, seeded, demonstrably production-grade application. All tests green. All docs current. Zach can hand this to a colleague tomorrow and they can deploy it.

## Working Style

- **Parallel sub-agents** for independent workstreams within a phase (e.g., schema + auth + mail abstraction in Phase 1). Reconcile in the main thread. Never parallelize work touching the same files.
- **Test-first for security-critical code** (auth, authorization, signing, audit chain). Write the test, watch it fail, make it pass.
- **Commit per logical unit** with conventional-commit messages. At minimum one commit per phase, usually more.
- **Run tests after every meaningful change.** Don't let the suite go red across multiple commits.
- **Time check at the end of each phase.** Note elapsed time and remaining scope in `PROGRESS.md`. If a phase took unexpectedly long, note why — it informs the deferral decision in Phase 6.
- **No silent deferrals.** If you skip something, write it loudly in `PROGRESS.md` under "Deferred" with the reason and the path forward.
- **Document as you go.** `DECISIONS.md` is a running log. Don't save it for the end.

## When You're Genuinely Stuck

A real blocker means: a missing system credential the owner must provide, an environmental failure that can't be worked around, or a security/legal question with no defensible default. In those cases, write the blocker fully to `BLOCKERS.md`, work around if possible, and continue with everything else. Do not halt the run waiting for the owner.

Begin with Phase 0. Note the start time in `PROGRESS.md` as your first action. Take the time it needs.
