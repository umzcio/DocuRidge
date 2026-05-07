# DocuRidge — Decisions Log

Running log of architectural and product decisions, with rationale. Append-only during the build; later decisions may supersede earlier ones, in which case the earlier entry is annotated, not deleted.

Format: each decision has **Decision**, **Why**, **Alternatives considered**, **Consequences**.

---

## D-001 — Stack confirmed

**Decision:** Next.js 15 (App Router) + TypeScript strict, Postgres 16, Prisma, Tailwind + shadcn/ui, pdf-lib, react-pdf/pdfjs, Argon2id (`argon2`), `jose` for JWS tokens, `@noble/ed25519` (or Node `crypto`) for the audit chain, Pino, Zod, nodemailer, Vitest, Playwright.

**Why:** Stack pre-blessed in `CLAUDE.md`. Spending research budget on UX prior art beats relitigating the stack. Versatile, well-supported, fits server-actions-heavy app with a PDF pipeline.

**Alternatives considered:** Remix (rejected — Server Actions in App Router cover the same ground); SvelteKit (rejected — smaller ecosystem for PDF tooling); a Node + Express + a separate React SPA (rejected — the integrated App Router model is fewer moving parts).

**Consequences:** Mutations primarily through Server Actions; route handlers reserved for callbacks (signing tokens, webhooks future, file streams). Full-stack TS gives shared Zod schemas across client + server.

---

## D-002 — Reverse proxy integration: deviation from amendment's `external: true` wording

**Decision:** DocuRidge compose declares a private network `docuridge_proxy_net` (not `external`). The owner attaches the existing `proxy` container to that network manually as a one-time deployment step (edit `/projects/proxy/docker-compose.yml`, add the network, recreate proxy with `docker compose -p proxy up -d`). The DocuRidge app container has no host port binding for public traffic; nginx reaches it as `docuridge_app:3000` over the shared network.

**Why:** The amendment instructed "attach the DocuRidge app container to that existing network as `external: true`." Inspecting the host showed `proxy` is attached to one dedicated network *per app* (legisview-net, ficino-network, bearcli_default, etc.) — there is no single "nginx upstream network" to join. The host's established convention is for each app to define its own network, and for the proxy to be attached to it by editing the proxy's compose. Following the host convention produces the same outcome the amendment asked for (no host port; private upstream link) while keeping ownership clean: DocuRidge owns the network, proxy joins it.

**Alternatives considered:**
- Use `external: true` on, say, `legisview-net`: rejected — we'd be coupling DocuRidge's lifecycle to legisview's network, and there's no semantic reason for that coupling.
- Bind app to a host port (e.g., 127.0.0.1:3737) and `proxy_pass` to `host.docker.internal:3737`: rejected — adds an unnecessary host port and breaks the host's pattern of container-name resolution.

**Consequences:**
- DEPLOYMENT.md must walk the owner through (a) appending `docuridge_proxy_net` to `/projects/proxy/docker-compose.yml`, (b) recreating proxy, (c) installing the nginx snippet, (d) reloading nginx.
- The compose file declares `docuridge_proxy_net` as a normal (non-external) network owned by the DocuRidge stack.
- Postgres and MailHog stay on a separate `docuridge_internal` network and are NOT attached to `docuridge_proxy_net`.
- MailHog UI and SMTP, plus Postgres, bind to `127.0.0.1` only on the host (never `0.0.0.0`), per amendment.

---

## D-003 — Subpath `/DocuRidge` baked in from Phase 1

**Decision:** `next.config.js` sets `basePath: '/DocuRidge'` and `assetPrefix: '/DocuRidge'` from the first commit. `PUBLIC_URL` (configured per-deploy, e.g. `https://docs.example.com/DocuRidge`) is the canonical source of truth for absolute URLs (email links, signing tokens, password-reset links). All cookies set `Path=/DocuRidge`. CSRF origin check validates against `PUBLIC_URL`'s origin. Trust `X-Forwarded-*` headers (rate limiter keys off real IP, secure-cookie flag follows `X-Forwarded-Proto`).

**Why:** Retrofitting basePath is brutal — every link, asset, fetch, redirect, and test breaks. Doing it from day one is essentially free.

**Consequences:**
- Internal links: `<Link>` only (basePath-aware); never raw `<a href="/...">`.
- API/server-action calls from client code: relative paths only, or via a basePath-aware helper.
- Path matches case-sensitively in nginx; DocuRidge is the canonical case. The nginx snippet redirects `/docuridge`, `/DOCURIDGE`, etc. to `/DocuRidge/`.
- Playwright `baseURL` for tests in the Docker network: `http://docuridge_app:3000/DocuRidge`.

---

## D-004 — Mail abstraction with code-level allowlist

**Decision:** Two mail backends behind a single `Mailer` interface: `MailHogMailer` (default, `MAIL_BACKEND=mailhog`) and `SmtpRelayMailer` (`MAIL_BACKEND=smtp_relay`). The SMTP relay backend wraps every `send()` in a recipient-allowlist function (`isAllowedRecipient(email): boolean`) called by the send pipeline. Membership is configured via the `MAIL_ALLOWLIST` env var (comma-separated addresses). Non-allowlisted recipients trigger: (1) refusal to send, (2) structured Pino warning with full context, (3) thrown error in non-production environments.

**Why:** Allowlist enforced *in code at the send pipeline* — not just in tests, not just in env config. This is a code-level safety net independent of the test suite. The function is unit-tested with its own dedicated suite. Removal at production deploy is a documented procedure in DEPLOYMENT.md (single env flag flips the gate off, and the gate function is removed in the same change).

**Consequences:**
- Mailer module shape: `transport` selected by env, `send()` always passes through the gate when SMTP relay is active, MailHog allows anything.
- Tests cover: gate allows allowlisted addresses, gate rejects everything else, gate refuses-with-log when active in production-ish mode, gate is bypassed cleanly when `MAIL_BACKEND=mailhog`.

---

## D-005 — Authorization: centralized `can()` function

**Decision:** All authorization decisions go through `can(user, action, resource)` defined in `src/lib/authz/can.ts`. Endpoints and Server Actions never check roles or permissions inline. The function consults a single permission map keyed by role and action, and resource-level checks (envelope ownership, org membership) live next to the actions they describe.

**Why:** Scattered authz is the #1 source of IDOR. One function to read, one place to test, one place to extend.

**Consequences:**
- Roles for v1: `admin`, `sender`, `viewer`. Viewer is read-only on envelopes within their org.
- The signing flow uses *token authorization*, not role-based — recipients are unauthenticated. Token validation lives in `src/lib/signing/token.ts` and is tested separately.
- Adding a permission means: (1) add to the map, (2) write a unit test for the new entry, (3) call `can()` at the entry point. No exceptions.

---

## D-006 — PAdES: best-effort, not a blocker

**Decision:** Phase 4 attempts PAdES-style PDF signing via `node-signpdf` with a self-signed cert generated on first boot. If the integration proves fiddly with our PDF pipeline (form fields + appended audit page + attached JSON manifest), we ship the embedded signed JSON manifest + Ed25519 audit chain + appended human-readable audit page, and document the PAdES upgrade path in `DEPLOYMENT.md`.

**Why:** PAdES adds value only if it's correct end-to-end (CA-issued cert, LTV, etc.). v1 self-signed PAdES would fail Adobe Reader's trust UI anyway. The signed JSON manifest + verifiable Ed25519 chain delivers cryptographic integrity. PAdES is the next step, not the bar for v1.

---

## D-007 — Virus scanning: documented extension point only

**Decision:** Upload pipeline exposes `scanFile(buffer): Promise<ScanResult>` interface with a no-op default implementation. ClamAV wiring is documented in DEPLOYMENT.md as a config-only swap (the host already runs ClamAV containers for other apps).

**Why:** ClamAV adds ~1GB to the stack and slows boot. The interface is the contract; production swaps the impl.

---

## D-008 — Bootstrap admin via one-time token, not log-printed link

**Decision:** On empty DB, the bootstrap migration creates the org + admin user with `must_reset_password=true` and no usable password hash. A `BOOTSTRAP_TOKEN` (random, generated into `.env` on first `compose up` if not set) gates a one-time `/setup` route. First visit → setup page → admin enters token + sets password → bootstrap state clears → route 404s afterward. Bootstrap admin email/name/org default to placeholders (`admin@example.com`, `DocuRidge Admin`, `Acme Org`) and are configured via `BOOTSTRAP_*` env vars at deploy time.

**Why:** Logs end up in stdout, Docker logging drivers, and aggregators. A reset link in logs is a credential in logs. A dedicated env-gated token is closer to how real systems do this and isn't meaningfully more work.

**Consequences:**
- `.env.example` documents `BOOTSTRAP_TOKEN`. If unset on first boot, an entrypoint script generates one and writes it back to `.env` before app start (with a single console line: "Bootstrap token written to .env — see file"; the token itself is never logged).
- The `/setup` page enforces: bootstrap state is active, token matches (constant-time compare), basic password policy. Then sets password, clears bootstrap state, logs the admin in.
- Audit-event recorded: `org.bootstrap_completed`.

---

## D-009 — Sequential routing default; parallel as envelope config

**Decision:** Envelope creation defaults `routing_mode = 'sequential'`. `'parallel'` is a per-envelope config; the UI exposes it as a toggle. Sequential is the default because it matches what people expect (and matches DocuSign's default), and it's the simpler engine to validate first.

---

## D-010 — Multi-tenancy: org-scoped schema, no org-switching UI in v1

**Decision:** Every persisted row is org-scoped via `org_id` (FK + index). All queries are org-scoped at the data layer. There is no UI for users to switch orgs in v1; one user → one org. This keeps the schema future-proof for actual multi-tenancy without shipping the UX/permission complexity.

---

## D-011 — Soft delete strategy

**Decision:** `deleted_at` timestamp on `User`, `Document`, `Envelope`, `Template`. Recipients, fields, and audit events are not soft-deleted — they're integral to the envelope they belong to and persist for the lifetime of the parent. Audit events are append-only; no delete at all. Default Prisma queries filter `deleted_at IS NULL` via a base helper (or middleware); raw queries in the verify command intentionally include soft-deleted rows for cryptographic verification.

---

## D-012 — Rate limiting: in-process token bucket

**Decision:** v1 ships an in-process token bucket on `/login`, `/register`, `/password-reset`, signing-token endpoints, and bulk-send job creation. Keyed off real client IP (post `X-Forwarded-For` resolution).

**Why:** Single-process v1 deployment; this is sufficient and avoids a Redis dependency.

**Upgrade path (DEPLOYMENT.md):** Swap to Redis-backed token bucket when scaling beyond one container; the rate-limit module is a strategy interface so the swap is config-only.

---

## D-013 — Logging: Pino structured JSON, request-ID middleware

**Decision:** Pino with JSON output. Middleware assigns each request a UUID v4 request ID, attaches it to the logger context, and emits via `X-Request-ID` response header. Every log line carries: `requestId`, `userId` (if authenticated), `orgId`, `action`, `resource`, `outcome`. No `console.log` in committed code outside the logger module — enforced by an ESLint rule.

---

## D-014 — Schema migrations only; no `prisma db push` in any committed flow

**Decision:** Every schema change is a migration via `prisma migrate dev` locally and `prisma migrate deploy` in compose entrypoint. The compose stack runs migrations on boot before the app starts.

---

## D-015 — Health endpoints

**Decision:**
- `GET /healthz` — process is up (200 always when reachable).
- `GET /readyz` — process is up AND database connectivity verified (200) OR DB unreachable (503).
- Both served at `/DocuRidge/healthz` and `/DocuRidge/readyz` publicly through nginx; nginx healthcheck routes both. Internal Docker healthcheck hits the container directly bypassing nginx.

---

## D-016 — Phase ordering: 5 over 6

**Decision:** Phase 5 (UX self-critique) ships fully before any time goes into Phase 6 (bulk send). If time pressure arises, bulk send ships as schema + a "Coming soon" UI stub, with the implementation plan documented in `PROGRESS.md`. Bulk send multiplies any core-flow bug; a polished, accessible, trustworthy core beats a buggy bulk send.

---

## D-017 — Phase 5 screenshots preserved across iterations

**Decision:** Phase 5 saves Playwright screenshots to `/tmp/docuridge_screenshots/<view>/<viewport>_<iteration>.png`. Iterations append; nothing is overwritten. This makes before/after comparisons concrete (real diff, not vibes) and gives the owner reviewable artifacts.

---

## D-018 — Public-URL smoke suite is a post-deploy step, not CI

**Decision:** Phase 7 includes a small Playwright smoke suite that hits the production URL via `PLAYWRIGHT_BASE_URL`. This is a *post-deployment verification* step the operator runs after installing the proxy snippet, not a CI gate. The standard test suite runs in-network against `http://docuridge_app:3000/DocuRidge`.

**Why:** The smoke suite depends on infrastructure (nginx snippet installed, network attachment) outside the DocuRidge stack. CI would need that infra mocked or skipped. Cleaner to make it explicit: `npm run smoke:public`, with the URL configurable.

---

## D-019 — Unified `Envelope` table with `type` discriminator (Document | Template)

**Decision:** A template is just an envelope with `type = TEMPLATE`. One table, one set of queries, one validation surface, one set of permissions. Borrowed from Documenso. Instantiation creates a new envelope with `type = DOCUMENT` and copies fields/recipients-as-roles.

**Why:** Maintaining parallel `Template` and `Document` tables doubles every dashboard query, every authorization rule, every search index. The discriminator pattern keeps the surface area small.

**Source:** Documenso `EnvelopeType` enum.

---

## D-020 — Multi-document envelopes via `EnvelopeItem`

**Decision:** Envelopes contain one or more `EnvelopeItem` rows, each pointing at a `DocumentFile`. v1 UX defaults to single-document envelopes, but the schema supports multi-document at no additional cost.

**Why:** Senders bundle related documents (e.g., NDA + employment offer + W-4). Schema in place; UI for adding additional docs is a small add later. Also enables file replacement without rewriting the envelope.

**Source:** Documenso `EnvelopeItem` pattern.

---

## D-021 — Snapshot the template definition into the envelope at instantiation

**Decision:** When a template is instantiated, the field/recipient definition is *frozen* into `Envelope.templateSnapshot`. Subsequent edits to the source template do not retroactively change in-flight envelopes.

**Why:** A real bug class otherwise: sender edits a template mid-flight, a recipient already partway through suddenly sees different fields. The snapshot prevents that.

**Source:** DocuSeal's `submission.template_fields_snapshot`.

---

## D-022 — Signing tokens: JWS, single-use, time-bounded; only `jti` persisted

**Decision:** Signing tokens are JWS (HS256 with a per-deploy secret distinct from the org Ed25519 chain key). Claims: `envelopeId`, `recipientId`, `iat`, `exp`, `jti`. The `jti` is recorded in `Recipient.tokenJti` on first valid use; subsequent presentation rejected. Default TTL 14 days, configurable.

**Why:** Documenso stores raw `Recipient.token` and queries it directly — DB dump exposes live tokens. DocuSeal's `submitter.slug` is effectively permanent. We want signed (so we don't have to query the secret), single-use (so a stolen URL is one-shot), time-bounded (so leaks decay).

**Source:** Documenso/DocuSeal anti-patterns; standard JWS practice.

---

## D-023 — Two audit streams: `AuditEvent` (envelope) and `UserSecurityAuditEvent` (account)

**Decision:** Envelope-lifecycle events live in `AuditEvent` (chained, signed). Account-security events (login, lockout, password change, session revoke) live in `UserSecurityAuditEvent` (plain rows, append-only via DB role). Don't mix.

**Why:** Different consumers (legal vs. security ops), different retention, different access controls. Chain integrity matters for envelope events; account events are operational signal.

**Source:** Documenso's split into `DocumentAuditLog` and `UserSecurityAuditLog`.

---

## D-024 — Cryptographic audit chain is the v1 differentiator

**Decision:** Every `AuditEvent` row carries `prevHash`, `eventHash`, and an Ed25519 `signature` over `eventHash`. The `(envelopeId, seq)` pair is unique and monotonic. Chain head is the latest event; the sealed PDF embeds the chain-head signature for offline verification.

**Why:** Documenso, DocuSeal, OpenSign all use plain audit-event rows with no hash linking and no event signatures. For UM's regulated context, the audit trail must be tamper-evident — that's what makes it admissible evidence rather than just app logs.

**Source:** Prior-art review confirmed the gap; this is the single area where DocuRidge can be objectively better than the OSS field on day one.

---

## D-025 — Audit logs FK with `onDelete: Restrict`, never `Cascade`

**Decision:** `AuditEvent.envelopeId → Envelope.id` uses `onDelete: Restrict`. Same for `SealedDocument`. Soft-delete on the parent is fine; hard-delete is blocked until a documented retention policy permits.

**Why:** Documenso's published schema uses `onDelete: Cascade` on its audit log FK — deleting an envelope removes its history. That's evidence laundering. We refuse to ship it.

**Source:** Documenso schema (anti-pattern observed).

---

## D-026 — Coordinate system: top-left fractional in DB; convert in one place for pdf-lib

**Decision:** Field positions stored as `x, y, w, h` fractions in `[0.0, 1.0]` of page width/height, top-left origin. pdf-lib uses bottom-left absolute points. The conversion happens exactly once, in `src/lib/pdf/coords.ts`.

**Why:** Fractional coords survive PDF rotation/scale (the same field placement looks right on Letter and A4). Centralizing the bottom-left ↔ top-left flip prevents the bug class where one path forgets the conversion.

---

## D-027 — Background-job durability for critical transitions

**Decision:** State transitions that must not be lost — email send, advance-to-next-recipient, finalize-seal — are persisted to a `BackgroundJob` table and processed by an in-process worker with retries. Idempotency keys via job-type + payload hash.

**Why:** Fire-and-forget loses work on crash. Documenso's `BackgroundJob` table pattern is the right shape.

**Source:** Documenso `BackgroundJob`/`BackgroundJobTask`.

---

## D-028 — Append-only audit table enforced at the DB role level

**Decision:** The migration creating `audit_event` and `user_security_audit_event` also creates a dedicated DB role with `INSERT, SELECT` only; `UPDATE` and `DELETE` are revoked. The application connects as that role for audit writes. Verify-command reads via SELECT only.

**Why:** "Append-only" enforced in code means a future ORM bug or a misnamed bulk operation can blow it. DB role enforcement is the belt to the application code's suspenders.

---

## D-029 — Sealed PDF: pdf-lib for stamping, `@signpdf` toolchain attempted for PAdES (Phase 4)

**Decision:** All field-value rendering, signature image stamping, and audit-page rendering done via pdf-lib. PAdES-style cryptographic PDF signing attempted via `@signpdf/signpdf` + `@signpdf/signer-p12` + `@signpdf/placeholder-pdf-lib` with a self-signed P12 generated on first boot. If the integration is unstable, the embedded signed JSON manifest + Ed25519 chain + appended audit page is the v1 ceiling, with PAdES documented as the upgrade path.

**Why:** This is the de-facto Node toolchain — Documenso, OpenSign, and most others converge on it. self-signed P12 won't pass Adobe Reader's trust UI, but the verify command is the canonical integrity check and PAdES becomes "free" once the cert is real.

**Source:** OpenSign `PDF.js`; Documenso `signing` package.

---

## D-030 — Recipient privacy: ISOLATED by default, SHARED as opt-in

**Decision:** `Envelope.recipientPrivacy` defaults to `ISOLATED` — each recipient sees only their own fields and the document. `SHARED` is an explicit envelope-level option for transparency cases.

**Why:** DocuSign cannot do per-recipient hiding at all (longstanding community complaint). Documenso recently switched to showing all completed fields to all recipients — useful for transparency but wrong as a default for legal/HR documents where field values may be sensitive (e.g., compensation).

**Source:** [DocuSign Community envelope-visibility thread](https://community.docusign.com/esignature-111/envelope-visibility-2485); Documenso changelog.

---

## D-032 (retired by D-034) — was: defer drag-and-drop PDF-overlay placement to Phase 5

**Update:** Owner opted to land the drag-and-drop UI inside Phase 2, not Phase 5. See D-034.

## D-033 (retired by D-035) — was: multi-document envelopes schema-only

**Update:** Owner opted to land multi-doc support inside Phase 2, not later. See D-035.

## D-034 — Drag-and-drop builder, with click-to-place fallback

**Decision:** Phase 2 ships a drag-and-drop overlay builder where field-type tiles in a sidebar are drag-and-drop targets onto pdfjs-rendered page canvases. Placed fields are themselves draggable for repositioning. A keyboard / accessibility / testing fallback is exposed as click-to-arm-then-click-to-place: clicking a tile arms its type; the next click on a page places the armed field at that fractional coordinate.

**Why:** Original v1 mandatory list said drag-and-drop. The dual-path implementation (drag OR click) keeps drag-and-drop as the primary affordance for sighted mouse users while making the surface keyboard-and-screen-reader navigable.

**Implementation:** HTML5 native drag (`dataTransfer.setData('text/x-docuridge-field', type)`); for repositioning a placed field, an additional `text/x-docuridge-move` payload carries the field id. No drag library; the form is ~500 lines.

## D-035 — Multi-document envelopes shipped in Phase 2

**Decision:** The builder accepts multiple PDFs in a single envelope; each becomes an `EnvelopeItem` in upload order. The sealer combines all source documents (with copyPages from pdf-lib) into one sealed output, then appends the audit page once at the end. The signed JSON manifest records each source's SHA-256 + page count.

**Why:** Schema already supported it (D-020); UI was the only missing piece, and per-source SHA-256s in the manifest let a verifier confirm the sealer combined the exact inputs.

## D-036 — `pdfjs-dist` worker served by route handler, not /public

**Decision:** `/DocuRidge/pdf-worker` route handler reads `pdfjs-dist/build/pdf.worker.mjs` from `node_modules` at request time and streams it with a 1-year immutable cache header. Client code points `GlobalWorkerOptions.workerSrc` at this URL.

**Why:** Avoids committing a vendor binary, avoids a build-time copy step in the Dockerfile, survives `pdfjs-dist` upgrades without code changes, and works under Next.js standalone output.

---

## D-032-orig — Drag-and-drop PDF-overlay field placement deferred to Phase 5

**Decision:** Phase 2 ships form-driven field placement (page #, type dropdown, fractional x/y/w/h numeric inputs, with auto-detected page count from `pdfjs-dist`). The drag-and-drop-onto-PDF-preview UI named in the original v1 mandatory list is deferred to Phase 5 (UX polish), where it'll be built against the same Phase 2 server actions.

**Why:** The data model (fractional top-left coords) and server actions are already drag-and-drop-ready; the deferred work is purely a builder client component. Polishing it inside the dedicated Phase 5 screenshot-iteration loop will produce a better UI than squeezing it into the substrate phase. The form-driven UI lets us validate every other Phase 2 backend behavior (sealing, audit chain, signing flow) end-to-end now.

**Consequences:** README + DEPLOYMENT.md note this UX gap. Phase 5 task list adds "drag-and-drop builder overlay" as the first item.

---

## D-033 — Multi-document envelopes: schema only in v1

**Decision:** `EnvelopeItem` already supports multiple PDFs per envelope and `seal.ts` loops over items, but the Phase 2 builder accepts a single PDF per envelope. Multi-doc UI is a Phase-3-or-later follow-up.

**Why:** Multi-doc UI complicates the field-placement surface (which document is this field on?), the recipient view (paginate or stack?), and the sealed output (combine or attach separately?). Single-doc covers >90% of UM's likely use cases and lets us ship a polished v1.

**Consequences:** A TODO in `seal.ts` notes the simplification; Phase 6 (or a small standalone follow-up) adds the second-file UI without schema changes.

---

## D-031 — Email branding built-in

**Decision:** Org-level `logoUrl` and `senderEmailFromName` apply to every outbound email and to the signing landing page. No "premium" gate.

**Why:** SignWell and Dropbox Sign treat branding as a paid upgrade, which results in legitimate emails looking like generic platform mailers — feeding the phishing-fatigue problem. We charge nothing for trust.

**Source:** SignWell branding-customization complaints.

---

