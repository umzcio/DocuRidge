<p align="center">
  <img src="public/docuridge-wordmark.png" alt="DocuRidge" width="420" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/docuridge-Self_Hosted_E_Signature-2544FB?style=for-the-badge&labelColor=0A163F" alt="DocuRidge" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-v1.0-2544FB?style=flat-square" alt="v1.0" />
  <img src="https://img.shields.io/badge/license-GPL--3.0-2544FB?style=flat-square" alt="GPL-3.0" />
  <img src="https://img.shields.io/badge/stack-Next.js%2015%20%7C%20Postgres%2016%20%7C%20Prisma-0A163F?style=flat-square" alt="Stack" />
  <img src="https://img.shields.io/badge/crypto-Argon2id%20%7C%20Ed25519%20%7C%20JWS-34d399?style=flat-square" alt="Crypto" />
</p>

<p align="center">
  <strong>Self-hosted e-signature platform with a cryptographic audit ridge.</strong><br/>
  Drop it on your own infrastructure. Sign documents, seal them, verify them — without ever sending data to a SaaS.<br/><br/>
  <a href="#quick-start">Quick Start</a> · <a href="#features">Features</a> · <a href="#audit-chain--seal-verification">Audit Chain</a> · <a href="SECURITY.md">Security</a>
</p>

<p align="center">
  <img src="docs/media/builder-overview.png" alt="DocuRidge envelope builder — recipients, fields palette, sequential routing, and a live PDF with color-coded signature fields placed for two recipients" width="900" />
</p>

---

## Why

Most e-signature platforms are SaaS — they're expensive, opaque, and store every document you've ever signed on infrastructure you don't control. For organizations that handle FERPA / HIPAA / GDPR-adjacent paperwork, that's a real problem; for individuals, it's a quiet one.

DocuRidge is what you get if you decide the e-signature stack should live next to everything else you self-host: same Docker network, same backups, same threat model. A **ridge** is a tamper-evident chain — every state-changing event hashed, signed with an org-scoped Ed25519 key, and chained by `prev_hash`. The sealed PDF embeds the manifest as a PDF attachment, the audit log as a human-readable final page, and the cryptographic chain head in the document hash. One command (`npm run verify <pdf>`) re-walks the ridge and tells you whether anything has been touched since the seal.

---

## How It Works

```
Upload PDFs --> Place Fields --> Send Envelope --> Recipient Signs --> Seal & Verify
```

1. **Sender uploads** one or more PDFs. Size + MIME validated, SHA-256 hash recorded, virus-scan extension point documented.
2. **Drag-and-drop fields** onto each page: signature, initials, date, text, number, checkbox, radio, dropdown, name, email, phone, address, company, formula, attachment, approve / decline, note, line, stamp, drawing. Multi-select toolbar, per-recipient assignee chip, per-field conditional logic.
3. **Add recipients** with sequential or parallel routing. New roles supported: APPROVER, WITNESS, IN_PERSON_SIGNER. Conditional routing skips a recipient unless an earlier field has the trigger value.
4. **Send the envelope.** Each recipient gets a time-bounded JWS signing link bound to the envelope and that recipient's record. Issuing a new link — a reminder, or a reassignment to a different person — immediately invalidates the previous one; the current link stays usable until they sign, decline, or it expires.
5. **Recipient signs** at their unique URL — UETA/ESIGN-aware consent, in-browser PDF preview, multi-font typed signatures (Caveat, Dancing Script, Great Vibes, Sacramento), drawn signatures with quadratic-curve smoothing, drawing fields for freeform marks.
6. **Audit events fire** at every step — `envelope.sent`, `recipient.viewed`, `recipient.signed`, `envelope.completed`. Each is hashed, Ed25519-signed, and chained.
7. **Final seal**: signatures stamped onto the PDF, audit page appended, signed JSON manifest embedded as a PDF attachment, document hash recorded in the chain head.
8. **Verify any time**: `docker compose -p docuridge exec app npm run verify -- --fingerprint <org key fingerprint> <sealed.pdf>` checks the signing key against the fingerprint you supplied, re-walks the chain, recomputes the per-page content digests recorded in the signed manifest, verifies every Ed25519 signature, exits non-zero on any tamper. PDFs sealed before this check was added carry a v1 manifest, which does not cover the document body: `verify` exits 5 (`VERIFY INCOMPLETE — LEGACY MANIFEST`) unless you pass `--allow-legacy-manifest` — re-seal to get body-tamper protection.

---

## Features

### Documents & Fields
- **PDF editing before sending**: rotate pages or the whole document, reorder/delete pages, add text/highlights, undo and cancel. Existing fields follow page changes; edited PDF bytes are saved through the usual upload flow. See [usage and supported PDFs](docs/pdf-preparation.md).
- **AI: Suggest fields**: optional vision-based detection of signatures, initials, dates, text and checkboxes, with on-page review, editable placement and recipient assignment. Requires an operator-configured AI service; see [configuration and limits](docs/ai-field-suggestions.md). Analysis sends page images/text to that service only when requested.
- **PDF upload pipeline**: size + MIME validated, multi-document envelopes, in-browser preview with page navigation, anchor-tag autoplacement (embed `{{sig:1}}` / `{{date:2}}` markers in your PDF, click "Auto-detect" to populate fields)
- **23 field types**: signature, initials, date, text, number, checkbox, radio, dropdown, name, email, job title, phone, address, company, formula (recursive-descent expression parser with 18 unit tests), attachment, approve, decline, note, line, stamp, drawing
- **Per-field properties** via JSON meta: read-only, char limit, regex pattern, min/max for numbers, options for select fields, formula expression, conditional show-if rule, recipient-uploaded attachment, sender-uploaded stamp image
- **Multi-select contextual toolbar**: select multiple fields with shift-click, change required state / recipient / size in bulk
- **Per-field assignee chip**: tiny pill on each placed field opens a portalled menu to reassign without touching the right rail
- **Conditional logic**: any field can be hidden until a source field has a chosen value; the source picker adapts to the source type (CHECKBOX → checked/unchecked, DROPDOWN/RADIO → option select, everything else → exact match)

### Recipients & Routing
- **Sequential or parallel** routing (default sequential)
- **Six roles**: SIGNER, APPROVER, CC, VIEWER, WITNESS, IN_PERSON_SIGNER
- **Conditional routing**: skip a recipient unless an earlier field has the trigger value — recorded in the audit chain as `signing_status=SKIPPED`
- **Reassign-by-recipient**: a recipient who was sent the envelope by mistake can forward it to the right person (audit-recorded, generates a fresh JWS-signed token for the new email)
- **Decline with reason**, **finish-later drafts** persisted client-side and resumed when they return

### Signing Ceremony
- **UETA / ESIGN-aware consent**: explicit disclosure, version-tagged in the audit chain
- **Multi-font typed signatures**: four cursive fonts (Caveat, Dancing Script, Great Vibes, Sacramento), live preview, font choice persisted on the Signature row
- **Drawn signatures**: pointer-event canvas with quadratic-curve smoothing and coalesced events for sub-frame stroke fidelity, trimmed PNG export
- **DRAWING field**: freeform mark capture for diagrams, freehand notation, anything beyond a signature
- **Saved defaults**: a recipient can save their drawn signature + initials and apply-to-all on subsequent envelopes
- **Comments thread**: back-channel between sender and recipient, scoped to the envelope

### Templates & Bulk
- **Reusable templates**: save any envelope's structure (documents + fields + recipient roles) as a template, instantiate with role → email mapping
- **PowerForms**: public template links that mint a fresh envelope per submission (anonymous senders, optional)
- **Bulk send**: upload a CSV against a chosen template, one envelope per row, allowlist gate still applies, status dashboard surfaces per-row errors

### Cryptographic Audit Chain
- **Every state-change** is an `AuditEvent` row — `envelope.sent`, `recipient.signed`, `email.failed`, `envelope.voided`, etc. — with `{prev_hash, event_data, actor, ip, user_agent, timestamp, signature}`
- **Org-scoped Ed25519 key** generated on first boot, persisted to a dedicated volume, file permissions locked, never logged, never API-exposed
- **Chain signing**: each event's hash signed with `@noble/ed25519`, chain head recorded on the SealedDocument
- **Sealed PDF output**: signatures stamped, human-readable audit page appended (with full recipient + field history), signed JSON manifest embedded as a PDF attachment, document hash bound into the chain
- **Verify command**: `npm run verify -- --fingerprint <org key fingerprint> <sealed.pdf>` — exits non-zero on any tamper, and on any document whose signing key is not the one you pinned. Tested against PDF tamper, audit event tamper, chain truncation, signature forgery, re-signing with a different key

### Operator Surface
- **Mail abstraction**: two backends (`mailhog` for dev, `smtp_relay` for production)
- **Code-level recipient allowlist** with its own unit tests (10 tests covering case, whitespace, subdomain spoofing, local-part spoofing, edge-case input). Configured via `MAIL_ALLOWLIST` env var
- **Brand color customization**: hex picker drives email button color and the signing-page header accent
- **Email logo upload**: per-org logo (PNG / JPEG / WebP, ≤200KB) appears at the top of every notification email
- **Custom email footers**, **default field font** (sans / serif / mono — drives the standard pdf-lib font used on sealed PDFs)
- **Folders**: nested envelope organization
- **Bulk dashboard actions**: void / delete-drafts on multiple envelopes from the list view
- **Webhooks**: HMAC-SHA256-signed POST to your URL on every audit event (`X-DocuRidge-Signature: sha256=<hex>`)
- **Forward-completed**: send a signed PDF view-link to additional recipients after completion, with a per-link expiration
- **"Clear all" notifications**: per-user `notificationsClearedAt` cursor — the audit chain stays untouched, the bell just hides events older than the cursor

### Auth & Authorisation
- **Email + password**: Argon2id, email verification, password reset, account lockout after N failed attempts
- **Server-side sessions** via httpOnly cookies, CSRF protection on every server action
- **Org-scoped multi-tenancy** with `ADMIN` / `SENDER` / `VIEWER` roles
- **Centralized `can(user, action, resource)`**: the only authorization surface in the app — every endpoint, every action, every resource passes through it
- **Strategy-swap auth**: SSO (SAML / OIDC / CAS / Shibboleth) is plug-in work, not a rewrite — the auth layer is designed for the swap
- **Rate limiting** on `/login`, `/register`, `/password-reset`, signing-token endpoints — in-process token bucket, documented upgrade path to Redis

### Accessibility & Polish
- **WCAG 2.1 AA verified**, axe-core run in Playwright
- **Keyboard navigation** works for every flow including the signing ceremony
- **Mobile signing** tested at 390px (iPhone SE width)
- **ESC closes** every modal; focus management correct on route changes
- **Loading / error / empty states** explicit for every primary view

---

## See It In Action

**Full walkthrough on YouTube** — the entire flow: builder, multi-recipient routing, signing ceremony, sealed PDF, audit verification.

<p align="center">
  <a href="https://youtu.be/j0gYGRn2nuU">
    <img src="https://img.youtube.com/vi/j0gYGRn2nuU/maxresdefault.jpg" alt="DocuRidge — full walkthrough (YouTube)" width="720" />
  </a>
  <br/>
  <sub><a href="https://youtu.be/j0gYGRn2nuU">▶ Watch on YouTube</a></sub>
</p>

Or just glance at the signing ceremony in motion:

<p align="center">
  <img src="docs/media/signature-flow.gif" alt="DocuRidge signing ceremony — recipient adopts a typed signature, places it on the document, and confirms" width="900" />
</p>

> Higher-quality mp4 of the same clip is attached to the <a href="https://github.com/umzcio/DocuRidge/releases/tag/v1.0.0">v1.0.0 release</a>.

Each placed field carries the recipient's color so the document tells you at a glance who needs to sign what. The contextual toolbar appears on multi-select for bulk required-toggle, reassign, or delete:

<p align="center">
  <img src="docs/media/field-placement-detail.png" alt="Two recipients' fields placed on the same authorization-and-acceptance page — color-coded blue and copper — with the multi-select toolbar floating above the selection" width="900" />
</p>

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Next.js 15 App Router · TypeScript strict · Tailwind · Server Components + Server Actions |
| **PDF** | pdf-lib (stamping + sealing) · pdfjs-dist (in-browser preview + anchor-tag scanning) |
| **Database** | PostgreSQL 16 · Prisma (versioned migrations, no `db push`) |
| **Auth** | Argon2id (password hashing) · jose (JWS signing tokens) · server-side sessions |
| **Crypto** | @noble/ed25519 (audit chain signing) · org-scoped key generated on first boot |
| **Mail** | nodemailer · two transports (MailHog / SMTP relay) · code-level allowlist gate |
| **Logging** | Pino (JSON) · per-request ID · user / action / resource fields |
| **Validation** | Zod everywhere — every request parsed and validated before it touches business logic |
| **Tests** | Vitest (unit + integration) · Playwright (e2e + a11y + smoke) |
| **Deployment** | Docker Compose · stack-isolated to `docuridge_*` containers / networks / volumes |

---

## Architecture

```
                        +------------------+
                        |    Browser       |
                        |  Next.js 15 RSC  |
                        +--------+---------+
                                 |  HTTPS at /DocuRidge
                        +--------+---------+
                        |  Reverse Proxy   |
                        |  (your nginx /   |
                        |   Caddy / etc.)  |
                        +--------+---------+
                                 |
                  +--------------+--------------+
                  |                             |
         +--------+---------+         +--------+---------+
         | docuridge_app    |         | docuridge_       |
         | Next.js + Prisma |         |   mailhog        |
         +--------+---------+         +--------+---------+
                  |                             |
         +--------+---------+         +--------+---------+
         | docuridge_       |         | external SMTP    |
         |   postgres       |         |   relay          |
         | (FS-encrypted)   |         |                  |
         +-------------------+        +------------------+
                  |
         +--------+---------+
         | docuridge_data   |
         |   /uploads       |
         |   /sealed        |
         |   /attachments   |
         |   /keys          |
         +-------------------+
```

The reverse proxy is yours — DocuRidge ships an example nginx snippet and connects via a docker network so the app container is never exposed on a host port.

---

## Quick Start

**Prerequisites:**
- Docker & Docker Compose
- A reverse proxy (nginx, Caddy, Traefik) — or use the local-dev override that binds to `127.0.0.1:3737`

**Setup:**

```bash
# Clone
git clone https://github.com/umzcio/DocuRidge.git
cd DocuRidge

# Configure environment
cp .env.example .env
# Edit .env — DATABASE_URL, PUBLIC_URL, MAIL_BACKEND, BOOTSTRAP_*

# Launch the stack (all containers/networks/volumes scoped to "docuridge")
docker compose -p docuridge up --build -d

# Watch the entrypoint until it reports "Ready"
docker compose -p docuridge logs -f app

# Read the bootstrap token (auto-generated into .env on first boot)
grep '^BOOTSTRAP_TOKEN=' .env

# Visit /DocuRidge/setup with the token, choose an admin password, sign in.
```

### Local development without a reverse proxy

```bash
docker compose -p docuridge -f docker-compose.yml -f docker-compose.local.yml up --build -d
# now reachable at http://127.0.0.1:3737/DocuRidge
```

The override file binds the app to **`127.0.0.1:3737`** (loopback only, never `0.0.0.0`) and is **not** auto-loaded — production deploys stay isolated to the docker network.

### Tests

```bash
npm install
npm run test          # Vitest unit + integration
npm run test:e2e      # Playwright (requires the stack to be running)
```

---

## Audit Chain & Seal Verification

The chain is the heart of DocuRidge. Every audit event is a row:

```ts
{
  envelopeId: string,
  seq: number,                 // monotonic per-envelope
  prevHash: string,            // sha256 of the previous event in this envelope
  type: 'envelope.sent' | 'recipient.signed' | ...,
  data: { ... },               // canonical-JSON of the event payload
  actor: string,
  ipAddress: string,
  userAgent: string,
  timestamp: Date,
  eventHash: string,           // sha256 of (prevHash + canonical(data) + ...)
  signature: string,           // ed25519 signature of eventHash with the org key
}
```

The sealed PDF carries:
1. **Stamped fields** — signature images, typed cursive (rendered to PNG client-side so pdf-lib doesn't need custom font embedding), checkmarks (drawn as vector strokes because pdf-lib's standard fonts can't encode U+2713), date / text / formula values
2. **Human-readable audit page** appended at the end with the full event timeline
3. **Signed JSON manifest** embedded as a PDF attachment containing every event, the chain head hash, and the manifest's own ed25519 signature
4. **Document hash** bound into the chain so the sealed PDF is non-substitutable

Verify any sealed PDF against the org's signing key:

```bash
docker compose -p docuridge exec app npm run verify -- --fingerprint <org key fingerprint> /path/to/sealed.pdf
# or pin the public key itself (the file may hold several PEM blocks, e.g. rotated keys)
docker compose -p docuridge exec app npm run verify -- --key /path/to/org-signing-key.pem /path/to/sealed.pdf
```

**The trust anchor must come from outside the PDF.** The manifest embeds the public key that signed it, but anyone can alter a sealed PDF, re-sign it with a key of their own, and embed that key instead; every signature check then passes. So `verify` only reports `VERIFY OK` when the signing key matches a fingerprint (`--fingerprint`, repeatable) or public key (`--key <file>`) you supplied, or the `DOCURIDGE_VERIFY_FINGERPRINT` (comma-separated) / `DOCURIDGE_VERIFY_KEY_FILE` environment variables when no flag is given. With no trust anchor it still runs every check but ends with `VERIFY UNTRUSTED — key taken from the document` and exits 4. A key that doesn't match fails with code `untrusted_key` (exit 1).

Where relying parties get the fingerprint: an org admin sees it on any completed envelope's detail page (the "Certificate version · ed25519" panel) and on the completion certificate, and can read it with the public key from the `org_signing_key` table (`SELECT fingerprint, "publicKeyPem" FROM org_signing_key WHERE "revokedAt" IS NULL;`). Publish it through a channel recipients already trust (your website, a signed email, a contract annex) — never take it from the sealed PDF itself.

Exit codes: `0` verified against a trusted key, `1` failed (the `code:` line names the check, e.g. `post_seal_revision`, `duplicate_object`, `xref_mismatch`, `sealed_content_page_tree`, `sealed_content_pages`, `sealed_content_digest`, `untrusted_key`), `2` usage error, `3` unexpected error, `4` untrusted (no trust anchor supplied), `5` incomplete: a legacy (v1) manifest with no page-content digest, so the document body is not covered (exit `0` only with `--allow-legacy-manifest`).

The verifier:
- Checks the file is the single revision the sealer wrote, before reading anything else: any incremental update, `/Prev` link or bytes after the final `%%EOF` fails with `post_seal_revision`; an object number defined twice fails with `duplicate_object`; a cross-reference entry that resolves an object anywhere but where it is defined (or an object it does not list) fails with `xref_mismatch`; an unparseable file fails with `pdf_structure`. Viewers fetch objects through the cross-reference table while pdf-lib keeps the last definition in the file, so without this a file could show one thing and verify another. This applies to seals of every version
- Re-extracts the JSON manifest from the PDF attachment
- Checks that the manifest's signing key matches the trusted fingerprint/key, and that its declared fingerprint matches the embedded key
- Verifies the manifest's own signature against that key
- Re-walks every event and recomputes `eventHash` from `prevHash + data`
- Verifies each event's signature
- Walks the page tree strictly, for every digest version: each kid must be an indirect `/Type /Page` or `/Type /Pages` object whose `/Parent` is the node listing it, every `/Count` must match the pages below it, and nothing may be listed twice. Otherwise it fails with `sealed_content_page_tree`, because viewers and pdf-lib could disagree on which pages exist
- Recomputes the per-page sealed-content digest recorded in the signed manifest, using the digest version the manifest declares, and prints which version it checked (`sealed_content_pages` if the page count differs, `sealed_content_digest` if a page differs)
- Exits **non-zero** if anything fails

The sealed-content digest (`sealedContent.digestVersion` in the manifest; manifest `version: 3`) is a canonical hash of everything reachable from each page: inherited resources at any depth, every stream's dictionary and bytes, fonts, images, annotations and their appearance streams, `/MediaBox`/`/CropBox`/other boxes, `/Rotate`, plus catalog entries that change rendering such as `/OCProperties`. Version 3 (current) also signs the page tree (every `/Pages` node, its `/Count` and inheritable attributes, and its `/Kids` in order) and each page's index, so adding, hiding, re-ordering or re-parenting a page fails `verify`. Seals made with version 2 (2026-10-23 until version 3) still verify with their own algorithm and end with `VERIFY OK — DIGEST v2`: every page is covered and the page tree is checked structurally as above, but the tree is not signed. PDFs sealed before that carry digest version 1 (no `digestVersion` field), which covered only page content streams and direct XObjects: `verify` still passes them but prints `VERIFY OK — LEGACY DIGEST (v1)` and warns that nested resources, annotations and page boxes are not covered. `--strict` requires version 3 and rejects versions 1 and 2 (`sealed_content_legacy_digest`).

Manifests from the first releases (manifest `version: 1`) carry no `sealedContent` at all, so they bind the audit chain but not the document body: a v1 manifest copied from any genuine sealed PDF onto a forged body passes every other check, even against a pinned key. `verify` therefore ends such a result with `VERIFY INCOMPLETE — LEGACY MANIFEST (v1)` and exits 5. Pass `--allow-legacy-manifest` to accept it (`VERIFY OK — LEGACY MANIFEST (v1)`, exit 0) once you have established the body some other way, such as comparing the file's SHA-256 with a copy you already hold; `--strict` rejects it outright (`sealed_content_missing`).

Tested against: PDF byte-tampering, audit-event field-tampering, chain truncation, signature forgery, manifest substitution.

---

## Project Structure

```
DocuRidge/
├── docker-compose.yml
├── docker-compose.local.yml          # 127.0.0.1 binding for dev
├── .env.example
├── deploy/
│   └── nginx/docuridge.conf          # example reverse-proxy snippet
├── prisma/
│   ├── schema.prisma                 # full data model
│   └── migrations/                   # versioned migrations (no db push)
├── src/
│   ├── app/
│   │   ├── (auth)/                   # login, register, password reset
│   │   ├── dashboard/                # sender dashboard, envelopes, templates, settings
│   │   ├── sign/[token]/             # recipient signing ceremony
│   │   ├── form/[token]/             # PowerForms public route
│   │   ├── share/[token]/            # forward-completed view route
│   │   ├── setup/                    # one-time bootstrap
│   │   └── healthz, readyz/          # liveness + readiness probes
│   ├── components/                   # design-system primitives + dashboard chrome
│   ├── lib/
│   │   ├── audit/                    # event recording + chain signing
│   │   ├── auth/                     # session, passwords, can()
│   │   ├── crypto/                   # org-key generation + signing
│   │   ├── envelopes/                # lifecycle service (send / advance / void / complete)
│   │   ├── formula/                  # recursive-descent expression evaluator
│   │   ├── mail/                     # transport + allowlist
│   │   ├── pdf/                      # seal + anchor-tag scan + coords
│   │   └── webhooks/                 # HMAC-signed delivery
│   └── middleware.ts                 # request-ID, CSRF, trust-proxy
├── scripts/
│   ├── docker-entrypoint.sh          # bootstrap, migrate, start
│   └── verify.ts                     # the verify command
└── tests/
    ├── e2e/                          # Playwright
    └── unit/                         # Vitest
```

---

## Design Decisions

**Why bake basePath `/DocuRidge` in from day one?** Retrofitting it is brutal — every link, asset, fetch, redirect, and test breaks. Doing it from the first commit is essentially free, and it keeps subpath deployments first-class.

**Why store typed signatures as PNG instead of stamping cursive glyphs in pdf-lib?** Recipients pick from four cursive fonts (Caveat, Dancing Script, Great Vibes, Sacramento). Embedding all four as TrueType in pdf-lib would balloon the sealed PDF and require fontkit. Instead, the ceremony renders the chosen font to a high-res canvas, exports a trimmed PNG, and the seal pipeline embeds it like any other signature image. The sealed PDF stamps the actual cursive glyphs the recipient saw, with no custom font in the document.

**Why a code-level mail allowlist in addition to env config?** Defense in depth. The allowlist function (`isAllowedRecipient`) is called from the send pipeline whenever `MAIL_BACKEND=smtp_relay`. Refusal: log a structured warning, record an `EmailEvent` row, throw in non-production. A misconfigured env var alone cannot disable the safety net — removal is a code change documented in `SECURITY.md`.

**Why versioned Prisma migrations and not `prisma db push`?** Migrations are the schema change history. `db push` is a development convenience that makes the production migration runner unable to apply changes consistently. Every schema change here is a versioned migration that the entrypoint applies on startup.

**Why pdf-lib instead of a server-side headless browser?** pdf-lib operates on the actual PDF object graph — pages, fields, attachments, annotations. A headless browser would render to a new PDF and lose the ability to embed the signed JSON manifest as a proper PDF attachment that any standard PDF reader can extract.

**Why local Ed25519 instead of cloud KMS?** v1 is self-host-first. The org key is generated on first boot, persisted to a dedicated volume with `0600` permissions, and never logged. The cloud-KMS upgrade path is documented in `SECURITY.md` and is a strategy-swap, not a rewrite.

**Why a single canonical `can(user, action, resource)`?** Authorization logic scattered across endpoints is a pattern that ages badly. Centralizing it means every server action and route handler asks the same function the same question, and every authorization rule is unit-tested in one place.

---

## Roadmap

Out of scope for v1, on the path for future versions:

- **SSO**: SAML / OIDC / CAS / Shibboleth strategy implementations (auth layer is already designed for the swap)
- **KBA / ID verification**: third-party integration (Persona, ID.me, etc.) for high-assurance ceremonies
- **Cloud KMS / HSM**: key import flow + provider SDKs
- **Audit-chain externalisation**: write-only sink to a public ledger or shared archive for stronger non-repudiation
- **Notary / RON**: significant feature surface plus state-by-state legal review
- **Qualified Electronic Signatures (eIDAS QES)**: hardware crypto + qualified trust service provider
- **White-label theming**: full per-org theme override (DocuRidge currently customizes brand color + logo + email footer per-org)
- **Multi-language UI**: i18n catalog + locale switcher
- **Native mobile apps**: responsive web is the v1 target

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for ground rules, local dev setup, schema-change conventions, PR guidelines, and how to report security issues responsibly.

## License

[GPL-3.0](LICENSE) — open source, self-host freely. Redistribution requires that derivative works be released under the same license.

---

<p align="center">
  <em>"A document signed in haste is a document remembered at leisure."</em><br/>
  <sub>— DocuRidge, in the spirit of every CIO who has watched an unsigned PDF escape into the wild</sub>
</p>
