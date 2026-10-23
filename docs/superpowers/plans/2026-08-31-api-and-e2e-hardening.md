# Cycle 2 — REST API v1 + E2E Hardening for Phase 1 Features

> **For agentic workers:** Three agents run in parallel on one tree with
> strict file ownership. W-API owns `src/`; W-E2E-A and W-E2E-B own `tests/`
> ONLY and must never edit `src/` — if they hit a product bug, they report
> it, they don't fix it. SSO is dormant; nothing here depends on it.

**Goal:** Ship a read+send REST API with org-scoped bearer tokens, and
end-to-end Playwright coverage for the four Phase 1 features that currently
have unit tests only (access codes, correction, completion certificate,
pipeline reporting).

## Global Constraints

- Same as the Phase 1 plan: token-vocabulary Tailwind, repo idioms
  (zod-validated actions, sonner, Dialog), no git commits, no schema
  migrations (both applied already: `phase1_switch_gate`,
  `api_token_scopes` adding `ApiToken.scopes` default `"read"`).
- `ApiToken` model: orgId, userId (creator), name, tokenHash (unique),
  scopes ("read", "read,write"), lastUsedAt, expiresAt, revokedAt.
- The `Action` union in `src/lib/ratelimit.ts` is frozen by a unit test
  ("exactly one entry per action") — REUSE existing buckets for API rate
  limits: `share_view` for reads, `bulk_send_create` for writes. Note the
  semantic stretch in a comment.
- Read `src/middleware.ts` before writing API routes: API routes must not
  be swallowed by session redirects or server-action origin checks. Adjust
  only the minimal matcher/early-return needed for `/api/v1/*`, and run the
  middleware unit tests (`src/middleware.test.ts`) after.

---

### W-API — REST API v1 + token management

**Owns:** Create `src/lib/api/auth.ts`, `src/lib/api/auth.test.ts`,
`src/lib/api/serializers.ts` (+ `.test.ts`),
`src/app/api/v1/envelopes/route.ts`,
`src/app/api/v1/envelopes/[id]/route.ts`,
`src/app/api/v1/envelopes/[id]/documents/route.ts`,
`src/app/api/v1/envelopes/[id]/documents/[documentId]/route.ts`,
`src/app/dashboard/settings/api-token-actions.ts`,
`src/app/dashboard/settings/api-token-panel.tsx`,
`tests/e2e/api.spec.ts` (write only; integration owner runs it).
Modify: `src/app/dashboard/settings/page.tsx` (mount the panel in a new
"API tokens" tab, admin/owner-gated like Branding/Webhooks/SSO).

**Interfaces produced:**
- `authenticateApiRequest(req: Request): Promise<
    | { ok: true; token: { id; orgId; userId; scopes: string[] } }
    | { ok: false; status: 401 | 403; error: string } >`
  — parses `Authorization: Bearer …`, SHA-256 → `tokenHash` lookup,
  rejects revoked/expired, throttled `lastUsedAt` touch (update only when
  older than 60 s). Token plaintext format `dr_` + 32 url-safe random
  chars; only the SHA-256 hex is stored.
- `requireScope(auth, 'write')` helper → 403 `{ error }` JSON when missing.
- JSON envelope serializer: stable field names (camelCase), dates ISO,
  recipients summarized; unit-tested.
- Routes (all JSON, org-scoped, `orgId` pinned from the token — never from
  query params):
  - `GET /api/v1/envelopes?status=&q=&limit=&cursor=` →
    `{ envelopes, nextCursor }`; cursor = opaque base64 of
    `(sentAt, id)`; limit default 50 max 200.
  - `GET /api/v1/envelopes/:id` → detail (404 cross-org).
  - `GET …/:id/documents` → list; `GET …/documents/:documentId` → file
    bytes with the document's stored content type + `Content-Disposition`.
    Authorization mirrors the sealed-download can semantics
    (`envelope:download_sealed` via the existing `authorize` helper with a
    synthetic ctx from the token's userId/orgId — read how `authorize`
    works and reuse; record `envelope.downloaded` audit events like the
    sibling routes).
  - `POST /api/v1/envelopes` (write scope) — body zod schema `{ templateId:
    string, title?: string, recipients: [{ name, email, role? }] }`
    (1–25 recipients, same email/name validation as the builder). Reuses
    template instantiation + `dispatchSigningInvite` from
    `src/lib/envelopes/lifecycle.ts` exactly like `correctEnvelopeAction`
    does — no new send machinery. Returns 201 `{ envelopeId, status }`.
- `api-token-panel.tsx`: table of tokens (name, scopes badges, created,
    last used, expires, revoke button) + "Create token" dialog (name,
    read/write checkboxes, optional expiry days) → on success shows the
    plaintext token ONCE in a copyable box. Actions:
    `createApiTokenAction`, `revokeApiTokenAction` (owner/admin only;
    verify how settings actions gate admin — mirror branding-form).

**Tests:** unit tests for `authenticateApiRequest` (mocked prisma: valid,
revoked, expired, bad format), scope gate, serializer shape, POST body
validation matrix. All green via `npm test`.

**Acceptance:** `npm run typecheck` + `npm run lint` clean; new unit tests
pass; `tests/e2e/api.spec.ts` written covering: 401 without token, list
with token, cross-org 404, write-scope required for POST, template-send
round-trip, revoked token 401 (run by integration owner).

---

### W-E2E-A — e2e: access codes + envelope correction

**Owns:** `tests/e2e/access-codes.spec.ts`,
`tests/e2e/correction.spec.ts` ONLY.

**Environment:** the isolated e2e stack is ALREADY RUNNING at
`PLAYWRIGHT_BASE_URL=http://127.0.0.1:3738/DocuRidge` with
`MAILHOG_API_URL=http://127.0.0.1:8738/api/v2/messages`,
`DOCURIDGE_APP_CONTAINER=docuridge_e2e_app`,
`BOOTSTRAP_TOKEN=e2e-bootstrap-token-not-real`. Iterate with
`npx playwright test <file> --project=chromium-desktop`. NEVER run
`npm run e2e:up`, docker, or `migrate` — the stack is shared live.

**Spec requirements:**
- `access-codes.spec.ts`: (1) build+send an envelope with an access code on
  the recipient (use `builderUploadAndContinue`, `builderAddRecipient` —
  set the code in the add-recipient modal), open the signing link: an
  unlock step appears before signing; wrong code → generic error; 5 wrong
  → lockout message; correct code → ceremony proceeds; adopt + finish →
  completed. (2) control case: recipient without a code never sees the
  unlock step (assert directly after consent). (3) audit: envelope detail
  activity shows "unlocked with an access code".
- `correction.spec.ts`: send an envelope to two recipients (sequential);
  from the detail page: Correct → edit message + expiration → save;
  add a third recipient; replace the second recipient and assert the old
  signing link is dead (open it → invalid) and the new link works; remove
  a pending recipient; assert every operation produced `envelope.corrected`
  entries visible in the activity tab; assert a signed recipient's row
  shows no replace/remove affordance.

Follow existing spec idioms: `ensureLoggedInAsAdmin`-style login inline,
`appAlert` helper (include the sonner `.or()` clause), unique
`Date.now()` emails per test, `test.describe.serial` for multi-step flows.

**Acceptance:** both specs pass repeatably (run each at least twice);
zero `src/` modifications.

---

### W-E2E-B — e2e: completion certificate + pipeline

**Owns:** `tests/e2e/certificate.spec.ts`,
`tests/e2e/pipeline.spec.ts` ONLY. Same environment rules as W-E2E-A.

**Spec requirements:**
- `certificate.spec.ts`: complete an envelope via the typed-sign flow;
  on the detail page assert a "Certificate" link exists; download it via
  `page.request` (authenticated context) or click → assert response
  `content-type: application/pdf`; parse with `pdf-lib`
  (`PDFDocument.load`, `getTextContent` via pdfjs like
  `src/lib/completion-certificate.test.ts` does) and assert it contains
  "Certificate of Completion", the envelope title, and the recipient email;
  assert a non-completed envelope has no certificate link.
- `pipeline.spec.ts`: send two envelopes to different recipients; open
  `/dashboard/pipeline` via the sidebar link; assert both rows appear with
  status badges and "days pending" values; filter by status COMPLETED →
  rows drop out; CSV export via `page.request.get(exportUrl)` (authenticated)
  → assert `text/csv`, header row columns, and that both envelope titles
  appear; assert sender search narrows results.

**Acceptance:** both specs pass repeatably; zero `src/` modifications.

---

## Integration sequence (orchestrator)

1. Merge verification: `npm run typecheck && npm run lint && npm test`.
2. `npm run e2e:up` (image rebuild with API routes) → run
   `tests/e2e/api.spec.ts` → then the full suite.
3. Fix fallout via agent resume; rebuild local `docuridge` container.
4. Progress report.
