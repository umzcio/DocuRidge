# DocuRidge — Data Model

Postgres 16 via Prisma. Every persisted row is org-scoped. Soft-delete on `User`, `Envelope`, `DocumentFile`, `Folder`. Audit logs are append-only and FK-protected (`onDelete: Restrict`). Coordinate system for PDF fields documented below.

This schema covers every v1 feature, including bulk send and templates. It is the source of truth for `prisma/schema.prisma`.

---

## Conventions

- **IDs:** `cuid()` strings (Prisma default). Public-facing references that benefit from being un-guessable use a separate `secondaryId String @default(cuid())` field.
- **Timestamps:** `createdAt` and `updatedAt` on every mutable row.
- **Soft delete:** `deletedAt DateTime?` on `User`, `Envelope`, `DocumentFile`, `Folder`. A base helper filters `deletedAt: null` from default queries; verify-command queries intentionally bypass.
- **Org scoping:** every domain row carries `orgId` with index. Queries are constructed via `where: { orgId: ctx.orgId, ... }` — no row trusts a client-supplied `orgId`.
- **Audit-log integrity:** `AuditEvent` has `prevHash`, `eventHash`, `signature`. Append-only at the DB role level (the application role has `INSERT, SELECT` only; `UPDATE` and `DELETE` are revoked).
- **Coordinate system for PDF fields:** UI uses **top-left origin, normalized 0.0–1.0** within each page (so the same field positions survive PDF rotation/scale changes). pdf-lib uses bottom-left absolute points. Conversion happens in exactly one place: `src/lib/pdf/coords.ts`.
- **Hashed tokens:** persisted tokens (API keys, password reset, email verification) store SHA-256 hashes of the token. Signing tokens are JWS — the signature itself is the secret; only `jti` is persisted.

---

## Entity overview

```
Organisation 1───* OrgMember *───1 User
Organisation 1───* Envelope ──────────────────────┐
                                                  │
Envelope 1───* EnvelopeItem 1───1 DocumentFile    │
Envelope 1───* Recipient                          │
Envelope 1───* Field *───1 Recipient              │── all org-scoped
Recipient 1───* Signature                         │
Envelope 1───1 EnvelopeMeta                       │
Envelope 1───* AuditEvent (signed, chained)       │
Envelope 1───1 SealedDocument                     │
Envelope 1───* EmailEvent                         │
                                                  │
Organisation 1───* Folder, Template (Envelope)    │
Organisation 1───* BulkSendJob 1───* BulkSendRow ─┘

User 1───* Session
User 1───* PasswordResetToken (hashed)
User 1───* EmailVerificationToken (hashed)
User 1───* UserSecurityAuditEvent

Organisation 1───1 OrgSigningKey (Ed25519)
Organisation 1───* ApiToken (hashed)
Organisation 1───* WebhookSubscription 1───* WebhookCall

System: BackgroundJob, RateLimit, BootstrapState
```

---

## Tables

### `Organisation`

| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | |
| `name` | String | Display name on emails and signing pages |
| `slug` | String @unique | URL-safe |
| `logoUrl` | String? | Org-uploaded logo for email + signing page |
| `senderEmailFromName` | String? | Default "from" display name on outbound mail |
| `defaultEnvelopeTtl` | Int | Days until envelope expires; default 30 |
| `createdAt` | DateTime | |
| `updatedAt` | DateTime | |

### `User`

| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | |
| `email` | String @unique | Lowercased |
| `passwordHash` | String? | Argon2id; nullable for bootstrap admin pre-setup |
| `mustResetPassword` | Boolean @default(false) | Forces flow to /setup or /reset |
| `emailVerifiedAt` | DateTime? | |
| `name` | String | |
| `failedAttempts` | Int @default(0) | Lockout counter |
| `lockedUntil` | DateTime? | Lockout expiry |
| `lastSignedInAt` | DateTime? | |
| `createdAt` | DateTime | |
| `updatedAt` | DateTime | |
| `deletedAt` | DateTime? | |

Indexes: `(email)` already unique; `(deletedAt)` for filtering active.

### `OrgMember`

| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | |
| `orgId` | String @index | FK → Organisation |
| `userId` | String @index | FK → User |
| `role` | OrgRole | `ADMIN | SENDER | VIEWER` |
| `createdAt` | DateTime | |

Unique: `(orgId, userId)`.

```prisma
enum OrgRole { ADMIN  SENDER  VIEWER }
```

### `Session`

Server-side session store. The session ID in the cookie is a CSPRNG random; not a JWT.

| Field | Type | Notes |
|---|---|---|
| `id` | String @id | The cookie value |
| `userId` | String @index | |
| `orgId` | String @index | Captured at login |
| `ipAddress` | String | First seen IP |
| `userAgent` | String | First seen UA |
| `createdAt` | DateTime | |
| `lastSeenAt` | DateTime | Updated on each request |
| `expiresAt` | DateTime @index | Sliding expiry |
| `revokedAt` | DateTime? | Logout / password change |

### `PasswordResetToken` / `EmailVerificationToken`

Both share the same shape; separate tables to avoid mixing.

| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | |
| `userId` | String @index | |
| `tokenHash` | String @unique | SHA-256 of the token sent in email |
| `createdAt` | DateTime | |
| `expiresAt` | DateTime @index | 1h reset, 24h verify |
| `consumedAt` | DateTime? | Single-use marker |

### `UserSecurityAuditEvent`

Account-security events kept distinct from envelope events. Append-only.

| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | |
| `userId` | String @index | |
| `type` | String | `login_succeeded`, `login_failed`, `lockout_triggered`, `password_changed`, `password_reset_requested`, `password_reset_completed`, `email_verified`, `session_revoked` |
| `ipAddress` | String? | |
| `userAgent` | String? | |
| `data` | Json | Type-specific extra context |
| `createdAt` | DateTime @index | |

### `Envelope` (unified document/template)

Following Documenso's pattern. A template is just an envelope with `type = TEMPLATE`.

| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | |
| `secondaryId` | String @unique @cuid | Public-facing un-guessable ID for URLs |
| `orgId` | String @index | |
| `createdById` | String @index | FK → User |
| `folderId` | String? @index | FK → Folder |
| `type` | EnvelopeType | `DOCUMENT | TEMPLATE` |
| `status` | EnvelopeStatus | `DRAFT | SENT | IN_PROGRESS | COMPLETED | DECLINED | VOIDED | EXPIRED` |
| `title` | String | |
| `subject` | String? | Email subject (default "[sender] needs your signature: [title]") |
| `message` | String? | Optional sender note included in email |
| `templateOriginId` | String? @index | If instantiated from a template, the template's id |
| `templateSnapshot` | Json? | Frozen field/recipient definition at instantiation (DocuSeal pattern) |
| `routingMode` | RoutingMode | `SEQUENTIAL | PARALLEL`, default SEQUENTIAL |
| `recipientPrivacy` | Privacy | `ISOLATED | SHARED`, default ISOLATED |
| `expiresAt` | DateTime? | |
| `sentAt` | DateTime? | |
| `completedAt` | DateTime? | |
| `voidedAt` | DateTime? | |
| `voidReason` | String? | |
| `declinedAt` | DateTime? | |
| `createdAt` | DateTime | |
| `updatedAt` | DateTime | |
| `deletedAt` | DateTime? | |

Indexes: `(orgId, status, createdAt)` for dashboard sort; `(secondaryId)` already unique.

```prisma
enum EnvelopeType { DOCUMENT  TEMPLATE }
enum EnvelopeStatus { DRAFT  SENT  IN_PROGRESS  COMPLETED  DECLINED  VOIDED  EXPIRED }
enum RoutingMode { SEQUENTIAL  PARALLEL }
enum Privacy { ISOLATED  SHARED }
```

### `EnvelopeItem`

A single PDF inside an envelope. Multi-doc envelopes are supported.

| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | |
| `envelopeId` | String @index | |
| `documentFileId` | String | FK → DocumentFile |
| `order` | Int | 1-indexed display order within envelope |
| `title` | String | |
| `pageCount` | Int | Cached, used by builder |

Unique: `(envelopeId, order)`.

### `DocumentFile`

Storage abstraction. v1 uses a content-addressed filesystem path; future cloud storage is a swap.

| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | |
| `orgId` | String @index | Org-scoped storage path |
| `storageType` | StorageType | `LOCAL_FS | S3` (only LOCAL_FS in v1) |
| `storagePath` | String | `/data/uploads/<orgId>/<sha256>.pdf` |
| `mimeType` | String | Magic-byte sniffed |
| `sizeBytes` | Int | |
| `sha256` | String @index | Content hash |
| `uploadedById` | String? | FK → User |
| `scanStatus` | ScanStatus | `UNSCANNED | CLEAN | INFECTED | ERROR` (UNSCANNED in v1 no-op) |
| `scannedAt` | DateTime? | |
| `createdAt` | DateTime | |
| `deletedAt` | DateTime? | |

```prisma
enum StorageType { LOCAL_FS  S3 }
enum ScanStatus { UNSCANNED  CLEAN  INFECTED  ERROR }
```

### `Recipient`

| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | |
| `envelopeId` | String @index | |
| `email` | String | Lowercased |
| `name` | String | |
| `roleLabel` | String? | Friendly label for templates (e.g., "Manager") |
| `recipientRole` | RecipientRole | `SIGNER | APPROVER | CC | VIEWER`, default SIGNER |
| `signingOrder` | Int | Same value across recipients = parallel group within sequential mode |
| `readStatus` | ReadStatus | `NOT_OPENED | OPENED` |
| `signingStatus` | SigningStatus | `NOT_SIGNED | SIGNED | DECLINED` |
| `sendStatus` | SendStatus | `NOT_SENT | SENT | BOUNCED | FAILED` |
| `tokenJti` | String? @unique | Once a JWS token is consumed, this is set to its jti — single-use |
| `currentTokenExpiresAt` | DateTime? | |
| `sentAt` | DateTime? | |
| `openedAt` | DateTime? | |
| `signedAt` | DateTime? | |
| `declinedAt` | DateTime? | |
| `declineReason` | String? | |
| `expiresAt` | DateTime? | |
| `lastReminderSentAt` | DateTime? | |
| `nextReminderAt` | DateTime? | |
| `ipAddress` | String? | Captured on first open |
| `userAgent` | String? | Captured on first open |
| `consentGivenAt` | DateTime? | UETA/ESIGN consent stamp |
| `consentDisclosureVersion` | String? | Which version of disclosure they accepted |

Indexes: `(envelopeId, signingOrder)` for advancement queries; trigram on `email` and `name` for dashboard search.

```prisma
enum RecipientRole { SIGNER  APPROVER  CC  VIEWER }
enum ReadStatus { NOT_OPENED  OPENED }
enum SigningStatus { NOT_SIGNED  SIGNED  DECLINED }
enum SendStatus { NOT_SENT  SENT  BOUNCED  FAILED }
```

### `Field`

Field placement on a specific page of a specific envelope item, assigned to a recipient.

| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | |
| `envelopeId` | String @index | Denormalized for org-scoped queries |
| `envelopeItemId` | String @index | |
| `recipientId` | String @index | Whose field this is |
| `type` | FieldType | See enum |
| `page` | Int | 1-indexed |
| `x` | Decimal | Top-left x as fraction of page width (0.0–1.0) |
| `y` | Decimal | Top-left y as fraction of page height (0.0–1.0) |
| `w` | Decimal | Width as fraction of page width |
| `h` | Decimal | Height as fraction of page height |
| `required` | Boolean @default(true) | |
| `defaultValue` | String? | Pre-filled value |
| `meta` | Json? | Type-specific (dropdown options, regex, etc.) |
| `value` | String? | Filled value at signing time (text, date, checkbox state) |
| `filledAt` | DateTime? | |
| `order` | Int | Tab order |

```prisma
enum FieldType {
  SIGNATURE  INITIALS  DATE  TEXT  NUMBER
  CHECKBOX   RADIO     DROPDOWN
  EMAIL      NAME
}
```

### `Signature`

Captured signature image and/or typed-name representation. Separate from `Field` because a single recipient may have multiple signature fields all sharing a captured signature.

| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | |
| `recipientId` | String @index | |
| `fieldId` | String? @unique | Which field captured this; nullable if reused |
| `imagePngBase64` | String? | Drawn signature, 2× supersampled |
| `typedSignature` | String? | Typed value (renders as a designed font) |
| `capturedAt` | DateTime | |
| `ipAddress` | String? | |
| `userAgent` | String? | |

### `EnvelopeMeta`

Per-envelope settings split out so the main `Envelope` row stays narrow.

| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | |
| `envelopeId` | String @unique | |
| `signaturesAllowed` | Json | `{ drawn: bool, typed: bool, uploaded: bool }`; v1 default `{drawn: true, typed: true, uploaded: false}` |
| `reminderSettings` | Json | `{ daysBeforeFirst, daysBetween, maxReminders }` |
| `language` | String | BCP-47, default `en-US` |
| `redirectUrl` | String? | Where to redirect signer after signing (allowlisted) |

### `AuditEvent`  ← **the differentiator**

Append-only, hash-chained, Ed25519-signed. The legal-evidence record. Phase 4 hardens the cryptographic side; Phase 2 lays the schema and writes plain rows.

| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | |
| `envelopeId` | String @index | FK; `onDelete: Restrict` |
| `seq` | Int | Monotonic per-envelope sequence (1, 2, 3, ...). Unique on `(envelopeId, seq)` |
| `type` | String @index | See "Audit event types" below |
| `actorUserId` | String? | If authenticated user |
| `actorRecipientId` | String? | If unauthenticated signer (token holder) |
| `actorEmail` | String? | Captured at the moment |
| `actorName` | String? | Captured at the moment |
| `ipAddress` | String? | Real client IP from `X-Forwarded-For` |
| `userAgent` | String? | |
| `data` | Json | Event-specific payload |
| `prevHash` | String | SHA-256 of prior event's `eventHash`; genesis is `0` × 64 hex chars |
| `eventHash` | String @unique | SHA-256 of canonical-serialized event including prevHash |
| `signature` | String | Ed25519 signature of `eventHash` by org signing key |
| `signedByKeyId` | String | Org key fingerprint at signing time |
| `createdAt` | DateTime @index | |

DB role: app role has `INSERT, SELECT` only; `UPDATE` and `DELETE` revoked. The migration that creates the table also creates a separate `app_audit_role` and grants/revokes accordingly.

#### Audit event types (v1)

| Type | Triggered when |
|---|---|
| `envelope.created` | Sender drafts envelope |
| `envelope.field_added` / `envelope.field_removed` / `envelope.field_updated` | Builder ops |
| `envelope.recipient_added` / `envelope.recipient_removed` / `envelope.recipient_updated` | Builder ops |
| `envelope.sent` | Draft → Sent transition |
| `envelope.viewed_by_sender` | Optional, off by default in v1 |
| `email.sent` | Email handed to mailer |
| `email.delivered` / `email.bounced` / `email.failed` | If we get callbacks (v1: SMTP-only, no callbacks; rows for future) |
| `recipient.opened` | Signing token first validated |
| `recipient.consent_given` | Affirmative ESIGN consent click |
| `recipient.field_filled` | Each field commit |
| `recipient.signed` | Final confirm pressed |
| `recipient.declined` | Decline submission |
| `envelope.advanced` | Sequential routing advance |
| `envelope.completed` | All required recipients signed |
| `envelope.voided_by_sender` | Sender void action |
| `envelope.expired` | Expiration job |
| `envelope.sealed` | Sealed PDF generated |
| `envelope.downloaded` | Sealed PDF downloaded |
| `envelope.verified` | Verify command run (records who/when/result) |

### `SealedDocument`

The final, sealed artifact and its integrity metadata.

| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | |
| `envelopeId` | String @unique | |
| `documentFileId` | String | The sealed PDF (separate row in DocumentFile) |
| `manifestJson` | Json | The signed manifest (also embedded in the PDF) |
| `manifestSignature` | String | Ed25519 signature of manifest JSON |
| `chainHeadHash` | String | The eventHash of the last audit event at seal time |
| `signedByKeyId` | String | |
| `sealedAt` | DateTime | |

### `EmailEvent`

Tracks outbound mail attempts; signal but not first-class audit. Useful when a recipient says "I never got the email."

| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | |
| `orgId` | String @index | |
| `envelopeId` | String? @index | |
| `recipientId` | String? @index | |
| `type` | String | `sent | delivered | bounced | complained | failed` |
| `messageId` | String? | SMTP Message-ID header |
| `subject` | String? | |
| `toAddress` | String | |
| `error` | String? | If failed |
| `data` | Json? | |
| `createdAt` | DateTime @index | |

### `Folder`

Self-referential tree for organizing envelopes and templates.

| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | |
| `orgId` | String @index | |
| `parentId` | String? @index | Self-FK |
| `name` | String | |
| `type` | EnvelopeType | `DOCUMENT | TEMPLATE` (folders are typed) |
| `createdById` | String | |
| `createdAt` | DateTime | |
| `deletedAt` | DateTime? | |

### `BulkSendJob` / `BulkSendRow`

Phase 6 (or schema-only stub if deferred).

`BulkSendJob`:
| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | |
| `orgId` | String @index | |
| `templateEnvelopeId` | String | Source template (Envelope with type=TEMPLATE) |
| `createdById` | String | |
| `status` | BulkStatus | `PENDING | RUNNING | COMPLETED | FAILED | CANCELLED` |
| `totalRows` | Int | |
| `succeededRows` | Int @default(0) | |
| `failedRows` | Int @default(0) | |
| `csvFilename` | String | |
| `csvSha256` | String | Stored CSV hash for traceability |
| `createdAt` | DateTime | |
| `completedAt` | DateTime? | |

`BulkSendRow`:
| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | |
| `jobId` | String @index | |
| `rowNumber` | Int | 1-indexed |
| `recipientMap` | Json | `{ roleLabel: { email, name } }` |
| `fieldOverrides` | Json? | Pre-fill values |
| `envelopeId` | String? | Created envelope after dispatch |
| `status` | BulkRowStatus | `PENDING | DISPATCHED | FAILED | SKIPPED_ALLOWLIST` |
| `error` | String? | |

```prisma
enum BulkStatus { PENDING  RUNNING  COMPLETED  FAILED  CANCELLED }
enum BulkRowStatus { PENDING  DISPATCHED  FAILED  SKIPPED_ALLOWLIST }
```

### `OrgSigningKey`

Phase 4. Generated on first boot, persisted to a dedicated `/data/keys/` volume. The DB row is metadata only — the key file is the canonical secret.

| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | Used as `signedByKeyId` reference |
| `orgId` | String @index | |
| `algorithm` | String | `ed25519` |
| `publicKeyPem` | String | Stored, used for verify |
| `keyFilename` | String | Path under `/data/keys/` (filename only; private key never in DB) |
| `fingerprint` | String @unique | SHA-256 of the public key |
| `createdAt` | DateTime | |
| `revokedAt` | DateTime? | If rotated |

### `ApiToken`

For programmatic access (future). Stored as hash only.

| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | |
| `orgId` | String @index | |
| `userId` | String @index | |
| `name` | String | User-supplied label |
| `tokenHash` | String @unique | SHA-256 |
| `lastUsedAt` | DateTime? | |
| `expiresAt` | DateTime? | |
| `createdAt` | DateTime | |
| `revokedAt` | DateTime? | |

### `WebhookSubscription` / `WebhookCall`

Out of v1 scope but schema in place; clean extension point.

(Field shape mirrors Documenso's: subscription has `events[]` + `secret`; call has `payload`, `responseStatus`, `attempts`, `nextRetryAt`.)

### `BackgroundJob`

Durable job queue for transitions that must not be lost (advance-to-next, finalize-seal, deferred email send).

| Field | Type | Notes |
|---|---|---|
| `id` | String @id @cuid | |
| `type` | String @index | `email.send`, `envelope.advance`, `envelope.seal`, etc. |
| `payload` | Json | |
| `status` | JobStatus | `PENDING | RUNNING | COMPLETED | FAILED` |
| `attempts` | Int @default(0) | |
| `maxAttempts` | Int @default(5) | |
| `runAt` | DateTime | When it should be picked up |
| `lastError` | String? | |
| `lockedBy` | String? | Worker lock |
| `lockedAt` | DateTime? | |
| `createdAt` | DateTime | |

```prisma
enum JobStatus { PENDING  RUNNING  COMPLETED  FAILED }
```

### `RateLimit`

In-DB token bucket. Composite PK.

| Field | Type | Notes |
|---|---|---|
| `key` | String | E.g., `ip:1.2.3.4` or `user:abc` |
| `action` | String | E.g., `login`, `signing_token`, `bulk_send_create` |
| `bucket` | DateTime | Truncated time bucket (e.g., minute floor) |
| `count` | Int | |

PK: `(key, action, bucket)`. Indexed on `bucket` for cleanup.

### `BootstrapState`

Single-row table that controls the `/setup` route gating.

| Field | Type | Notes |
|---|---|---|
| `id` | Int | Always `1`; CHECK constraint enforces single row |
| `pendingAdminUserId` | String? | The admin awaiting first password set |
| `tokenHash` | String | SHA-256 of `BOOTSTRAP_TOKEN` |
| `completedAt` | DateTime? | When set, bootstrap is done; /setup → 404 |
| `createdAt` | DateTime | |

---

## Indexes (summary)

| Table | Index | Reason |
|---|---|---|
| `User` | `(email)` unique | Login |
| `OrgMember` | `(orgId, userId)` unique, `(userId)` | Auth lookups |
| `Session` | `(userId, expiresAt)`, `(expiresAt)` | Active sessions, cleanup |
| `Envelope` | `(orgId, status, createdAt)`, `(secondaryId)` unique, `(orgId, deletedAt)` | Dashboard sort, public ID lookup |
| `EnvelopeItem` | `(envelopeId, order)` unique | Multi-doc ordering |
| `Recipient` | `(envelopeId, signingOrder)`, GIN trigram on `email`, `name` | Routing advance, search |
| `Field` | `(envelopeId, recipientId)`, `(envelopeItemId, page)` | Builder + signing UI |
| `AuditEvent` | `(envelopeId, seq)` unique, `(eventHash)` unique, `(createdAt)` | Verify, timeline render |
| `EmailEvent` | `(envelopeId)`, `(recipientId)`, `(createdAt)` | Recipient debugging |
| `BulkSendRow` | `(jobId, rowNumber)` unique | Job dashboard |
| `BackgroundJob` | `(status, runAt)` | Worker poll |
| `RateLimit` | `(key, action, bucket)` PK, `(bucket)` | Bucket lookup, cleanup |

---

## Foreign-key behavior

- **`AuditEvent.envelopeId` → Envelope.id, `onDelete: Restrict`.** Audit logs outlive envelopes; you cannot evidence-launder by deleting the envelope. Soft-delete is fine; hard-delete is forbidden until audit retention policy permits.
- **`SealedDocument.envelopeId` → Envelope.id, `onDelete: Restrict`.** Same reason.
- **`Field.recipientId` → Recipient.id, `onDelete: Restrict`** when envelope is `SENT` or beyond. (Application-level check; DB defaults `Restrict`.)
- **`EnvelopeItem.envelopeId` → Envelope.id, `onDelete: Cascade`** (only meaningful for DRAFT envelopes; once sent, envelope is restrict).
- **`OrgMember.userId` → User.id, `onDelete: Cascade`.** User deletion removes membership; user soft-delete is the normal path.
- **`Session.userId` → User.id, `onDelete: Cascade`.** Logged-out anyway.

---

## Multi-tenancy notes

- Every `where:` clause in a Prisma query that touches an org-scoped table includes `orgId`. We use a thin `prisma.envelope.findFirstScoped(ctx, where)` helper that injects `orgId` automatically; raw `findFirst` is not used in route handlers.
- Storage paths embed `orgId`: `/data/uploads/<orgId>/<sha256>.pdf`. A path-traversal vuln must traverse a deliberate, authenticated org boundary.
- The verify command takes `--org=<orgId>` and refuses cross-org chain checks.

---

## Coordinate system (PDF fields)

- **UI / DB:** top-left origin, `x, y, w, h` in `[0.0, 1.0]` as fractions of page width/height.
- **pdf-lib:** bottom-left origin, absolute units in PDF user space points.
- **Conversion:** exactly one place — `src/lib/pdf/coords.ts`. Functions: `uiToPdf({x, y, w, h, page})` and `pdfToUi(...)`.
- **Why fractions:** survives PDF rotation and scale changes; a 595×842 A4 PDF and a 612×792 Letter PDF both store `x=0.5` for "centered horizontally" without transformation.

---

## Soft-delete strategy

- `User`, `Envelope`, `DocumentFile`, `Folder` carry `deletedAt`.
- A Prisma extension wraps the client to filter `deletedAt: null` on default reads. Verify-command code uses the unwrapped client.
- Audit events, signatures, signed-document rows, and email events are **never soft-deleted** — they're integral to the parent's evidentiary record.
- Hard-delete is reserved for: GDPR-style requests (with audit-event tombstone) and bootstrap reset (developer flow only).

---

## Migration plan

The initial migration creates every table above. Subsequent migrations add columns or indexes as features stabilize. Naming: `YYYYMMDDHHMMSS_<short-description>` per Prisma convention.

Migrations run on container boot via `npx prisma migrate deploy` in the entrypoint, before the Next.js server starts.

---

## Schema coverage check (v1 features)

| v1 feature | Tables that cover it |
|---|---|
| Auth & identity (Argon2id, lockout, RBAC, sessions, reset, verify) | `User`, `OrgMember`, `Session`, `PasswordResetToken`, `EmailVerificationToken`, `UserSecurityAuditEvent`, `Organisation` |
| Document upload & rendering | `DocumentFile`, `EnvelopeItem` |
| Field placement | `Field` |
| Multi-recipient sequential routing | `Recipient` (`signingOrder`), `Envelope.routingMode`, `BackgroundJob` (advance) |
| Signing ceremony | `Recipient` (`tokenJti`, `consentGivenAt`), `Signature`, `Field.value` |
| Cryptographic audit trail | `AuditEvent`, `OrgSigningKey` |
| Sealed PDF output | `SealedDocument`, `DocumentFile` (the sealed file row) |
| Email notifications | `EmailEvent`, `BackgroundJob` (queued send) |
| Templates | `Envelope.type=TEMPLATE`, `templateOriginId`, `templateSnapshot` |
| Envelope lifecycle | `Envelope.status`, `*At` timestamps, audit events |
| Audit view | `AuditEvent` query by envelope |
| Bulk send | `BulkSendJob`, `BulkSendRow`, `BackgroundJob` |
| Org branding | `Organisation.logoUrl`, `senderEmailFromName` |
| Bootstrap admin flow | `BootstrapState`, `User.mustResetPassword` |
| Rate limiting | `RateLimit` |
| API tokens (future) | `ApiToken` |
| Webhooks (future) | `WebhookSubscription`, `WebhookCall` |

Every v1 feature is represented. Out-of-scope items have schema seats (`WebhookSubscription`, `ApiToken`, `OrgSigningKey.revokedAt`-based rotation) so they slot in cleanly later.
