# Canonical source PDF (phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every uploaded PDF is rewritten once, in the PDF worker, into a canonical file that is exactly "the seal minus the stamps". Signers are shown that file, and the seal is built from it, so what a signer reviews and what gets sealed are the same bytes.

**Architecture:**
- **Upload.** A new worker job, `'canonicalize'`, replaces `'inspect'`. It does four things:
  1. runs phase 1's guards;
  2. refuses content the seal cannot reproduce: `/NeedAppearances`, visible non-widget annotations, and hidden optional content;
  3. flattens the form and draws every page upright on a fresh page, using the seal's existing pipeline (`appendUprightPages`);
  4. writes the result deterministically, then checks that it is a pdf-lib fixed point and passes `checkPdfStructure`.

  The parent stores the canonical file content-addressed, next to the original. The original is kept for provenance only. The canonical file's sha256, page count and seal cost go on the `DocumentFile` row.
- **Send.** The send-time check reads the seal cost from the database instead of re-parsing.
- **Serve.** The signing route serves the canonical file. So do the dashboard preview and the API download, by default.
- **Seal.** The seal copies the canonical pages (`copyPages`, no second flatten or embed) and stamps on top of them.
- **Rows without a canonical file.** Existing rows, and any row the backfill missed, are canonicalized on demand. A bundled backfill script does all of them at deploy.

**Tech Stack:** Node 22, TypeScript, pdf-lib 1.17.1, Prisma/Postgres, the phase-1 PDF worker (`src/lib/pdf-worker/`), esbuild, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-24-pdf-canonical-source-and-isolation-design.md` §2 (Canonical source document). Phase 1 (§1, §4) is shipped. Phase 3 (§3, the v4 seal and verifier) gets its own plan.

## Global Constraints

- **The repo is public.** Never write this host's production or tailnet names, or any part of them, into a file or commit message. Before every commit, run the host-name check from your brief on `git diff --cached` and the message, and require no output.
- **Commit identity** is `umzcio <umzcio@users.noreply.github.com>` (already the repo-local config). End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Signers never get the original bytes.** Every route a recipient can reach serves the canonical file or nothing. Only the sender's dashboard and the API can fetch the original, and only on explicit request: `?upload=1` on the dashboard, `?original=1` on the API.
- **Parsing stays in the worker.** Canonicalization runs only as the `'canonicalize'` job. The parent never loads an uploaded or canonical PDF with pdf-lib. Worker-side modules must not import `../prisma`, `../env`, `../crypto/*`, `../audit/*` or `../logger`, and must not read files (this is the phase-1 rule).
- **The parent trusts nothing from the child except validated shapes.** It computes the canonical sha256 itself, checks the output (`%PDF-` header, size cap, page count, seal cost within the caps), and never shows the child's text to users; refusals map to the fixed messages below.
- **Canonical storage:** `<UPLOADS_DIR>/<orgId>/canonical/<sha256>.pdf`, mode 0600. The relative path stored in the database is `<orgId>/canonical/<sha256>.pdf`. Write to a temporary name and rename, and keep an existing file as it is. Every read checks the sha256 against the row.
- **`CURRENT_CANONICAL_VERSION = 1`.** Bump it only when the canonical output changes on purpose. A row whose stored version is lower is canonicalized again only by the backfill run with `--recanonicalize`, never on demand. A signer may already have seen the old bytes.
- **Determinism.** The same input gives byte-identical canonical output. pdf-lib names resources with `Math.random()` (`addRandomSuffix`); the canonicalize job replaces `Math.random` with a fixed-seed generator for the duration of the job and restores it afterwards. The Info dictionary is exactly `/Producer (DocuRidge)`: no dates and no `/ID`.
- **Refusal messages**, fixed in the parent and keyed by `CanonicalRefusalKey`:

  | Key | Upload code | Message |
  |---|---|---|
  | `need_appearances` | `unsupported_form` | `This PDF form asks the viewer to redraw its fields, so it may not look the same when signed. Export a flattened PDF first.` |
  | `visible_annotations` | `unsupported_content` | `This PDF has comments, markup or stamps that would not appear in the signed copy. Flatten them (for example, print to PDF) and upload again.` |
  | `hidden_layers` | `unsupported_content` | `This PDF has hidden layers, so the signed copy could show content the signer never saw. Print it to a new PDF with the layers you want, and upload again.` |
  | `self_check` | `unreadable_pdf` | `DocuRidge could not prepare this PDF for signing. Try re-saving or printing it to a new PDF and uploading again.` |
  | `unsupported_form` | `unsupported_form` | the existing form message (with the existing `/flattened PDF/` pass-through) |
  | `no_pages`, `unreadable_pdf`, `pdf_too_complex` | as today | as today (`inspect-upload.ts`) |

- **The full unit suite, `npm run lint` (0 errors), `npx tsc --noEmit` and the isolated e2e suite pass at the end of every task that touches runtime code.** Run e2e with `npm run test:e2e:isolated` against a stack built with the scratch e2e override file (`image: docuridge_e2e_app:latest`), kept outside the repo. Never rebuild or retag `docuridge_app:latest` for tests.
- **`grep` and `seal.ts`.** `src/lib/pdf/seal.ts` and `seal-render.ts` contain a byte that makes the shell's `grep` treat them as binary. Use `grep -a` on them.

## Calls made in this plan (the spec left them open, or this plan departs from it)

- **Two extra columns.** `DocumentFile` gets `canonicalSealCost Json?` and `canonicalRefusal String?`, beyond the spec's four. The send-time check needs the cost, and a template page needs the reason a file was refused.
- **Per-page sizes are not stored.** Nothing reads them.
- **The annotation rule is narrower than the spec's.** pdf.js draws its own appearance for many annotation types that have no `/AP`: Square, Ink, Highlight, FreeText and others. So, after the form is flattened, any annotation still on a page is refused unless one of these holds:
  - it is Hidden (flag 2) or NoView (flag 32);
  - it is a `/Link` or `/Popup` with no non-empty `/AP /N`.

  Orphan widgets, meaning those outside the `/AcroForm` field tree, are therefore refused too. Every real upload passes: the corpus has only Link annotations and in-tree widgets.
- **Optional content.** `/OCProperties` is accepted only when all of the following hold: the default configuration `/D` has an empty or absent `/OFF`; `/BaseState` is absent or `/ON`; `/D` has no `/AS`; and no OCMD (a dictionary with `/OCGs`, `/P` or `/VE` used as `/OC`) is reachable from any page. Then it is dropped. Anything else is refused as `hidden_layers`.
- **Sealing checks the canonical file again.** It re-runs `checkPdfStructure` and loads it in `'sealed'` page-tree mode before copying. One extra parse per document buys protection against a canonical file that is not what this code writes, for example after a disk edit or a compromised upload worker.
- **Dashboard query flags.** `/dashboard/envelopes/[id]/document?original=1` keeps its current meaning ("not the sealed file") and now returns the canonical file. `?upload=1` returns the uploaded original.
- **API download.** `GET /api/v1/envelopes/:id/documents/:documentId` returns the canonical file by default and the original with `?original=1`. The serializer gains `canonicalSha256`.
- **Client page counts are ignored.** `setEnvelopeItemPageCount` and its callers are removed; `addEnvelopeFile` writes `pageCount` from the canonical page count. The new-envelope action checks each field's page against that stored count.
- **The backfill is a bundled script.** It is built as `dist/canonical-backfill.cjs`, copied to `/app/canonical-backfill.cjs`, and run with `docker exec docuridge_app node /app/canonical-backfill.cjs`. The runtime image has no tsx.

## Review Focus

1. **An envelope already IN_PROGRESS at deploy whose document the canonicalizer refuses.**
   - The signing route answers 409 with `This document can't be shown right now. Contact the sender.` It never serves the original.
   - Completion records `envelope.seal_failed`, not retryable, with every signature kept.
   - The backfill report lists the envelope.

   Tests in Tasks 5 and 6.
2. **A rotated, cropped or UserUnit page.** A field must land in the same place on the canonical file as the sender placed it on the original. The canonical page size equals the displayed size (crop ∩ media × UserUnit, rotation applied), and its content sits where pdf.js showed it. Tests in Tasks 2 and 6.
3. **Two senders instantiate the same template at once while its file has no canonical copy yet.** Both succeed, there is one canonical file, and the row is written once. Test in Task 3.
4. **The canonical file is missing on disk, or its bytes don't match the row.** Signing answers 409 with the message from item 1. Sealing fails as not retryable with a fixed message naming the document. Neither ever serves or seals other bytes. Tests in Tasks 5 and 6.
5. **An encrypted upload, and a worker that is busy during upload.** Encrypted: canonical is built from the qpdf-decrypted bytes, and the original stored is the decrypted one, as today. Busy: the upload fails with `busy` and nothing is stored. Test in Task 3.

---

### Task 1: Source policy checks

Closes the refusal half of find_016H3wUkTnARCoD3T3mghHw6, find_01FS1qr8YPoZGndLMnzv6uu5 and find_01SNv2YpN7XQmYGvuQhLBJCs.

**Files:**
- Create: `src/lib/pdf/source-policy.ts` (worker-side)
- Create: `src/lib/pdf/__fixtures__/policy-pdfs.ts` (builds fixture PDFs with pdf-lib low-level objects)
- Test: `src/lib/pdf/source-policy.test.ts`

**Interfaces:**
- Produces:
  - `type SourcePolicyReason = 'need_appearances' | 'visible_annotations' | 'hidden_layers'`.
  - `class SourcePolicyError extends Error { readonly reason: SourcePolicyReason }`, with a fixed message per reason. These are internal; the parent uses the table in Global Constraints.
  - `assertNoNeedAppearances(doc: PDFDocument): void`. It throws `need_appearances` when `/AcroForm /NeedAppearances` is `true` and `/Fields` is non-empty. Call it **before** the form is flattened.
  - `assertNoVisibleAnnotations(doc: PDFDocument, leaves: PDFDict[]): void`. Call it **after** `flattenPdfFormAppearances`. It throws `visible_annotations` for any annotation on any leaf's `/Annots` that is not allowed by the rule in "Calls made in this plan". Count the annotations scanned against `getPdfSealLimits().maxAnnotations`.
  - `optionalContentPolicy(doc: PDFDocument, leaves: PDFDict[]): 'none' | 'all_on'`. It throws `hidden_layers` per the rule in "Calls made in this plan". The OCMD scan walks each page's `/Resources` (`/Properties`, and `/XObject` entries' `/OC`), with a visited set and the seal-object cap.
  - `SourcePolicyError` is added to the worker's error revival in `src/lib/pdf-worker/errors.ts`, so it crosses IPC with its `reason` as `code`.

- [ ] **Step 1: Write failing tests** in `source-policy.test.ts`. Fixtures come from `policy-pdfs.ts`.
  - `"refuses /NeedAppearances true on a form whose /V and /AP differ"` uses the finding's sample: `/V (12 months)` and an `/AP` that draws `36 months`. It expects `SourcePolicyError` with reason `need_appearances`.
  - `"accepts /NeedAppearances true on a document with no fields"` expects no throw.
  - `"refuses an opaque Square annotation over text"` uses the find_01FS1qr8YPoZGndLMnzv6uu5 sample and expects `visible_annotations`.
  - `"refuses a Square annotation with no /AP"` expects `visible_annotations`, because pdf.js draws one.
  - `"refuses an orphan widget outside the field tree"` expects `visible_annotations`.
  - `"accepts Link and Popup annotations without appearances, and a Hidden FreeText"` expects no throw.
  - `"refuses a Link with a visible /AP /N"` expects `visible_annotations`.
  - `"refuses an OFF group in /D /OFF"`: uses the find_01SNv2YpN7XQmYGvuQhLBJCs sample. Also refused: `/BaseState /OFF`, a `/D /AS` array, and an OCMD used as `/OC` on an XObject. Each case expects `hidden_layers`.
  - `"accepts groups that are all ON"` expects `'all_on'`. `"no /OCProperties"` expects `'none'`.
  - `"annotation scan is capped"`: one page with `maxAnnotations + 1` Link annotations expects `PdfComplexityError` with `limit === 'annotations'`. Use the existing limit name if seal-limits.ts already has one; otherwise add `'annotations'` to `PdfComplexityLimit`.
- [ ] **Step 2:** Run `npx vitest run src/lib/pdf/source-policy.test.ts`. Expected: FAIL (the module does not exist).
- [ ] **Step 3: Implement the interfaces above.** Read annotation flags with `PDFNumber` lookups, not pdf-lib's annotation classes, so malformed entries cannot throw from pdf-lib internals. An entry that is not a dictionary is refused as `visible_annotations`.
- [ ] **Step 4:** Run the same command, then `npx vitest run src/lib/pdf`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(pdf): refuse source content the seal cannot reproduce`.

### Task 2: The canonicalize job

Closes the view-vs-seal half of find_019pUbrXFsNQhGPYgxUwMpKb and find_01MPXLxm41G5RC1ojiExrcg4, once Task 5 serves the result.

**Files:**
- Create: `src/lib/pdf/canonicalize.ts` (worker-side)
- Create: `src/lib/pdf/canonical-result.ts` (parent-side validation; imports types only from `canonicalize.ts`)
- Modify: `src/lib/pdf-worker/protocol.ts` and `src/lib/pdf-worker/jobs.ts` (add `'canonicalize'`). `'inspect'` stays until Task 4.
- Modify: `src/lib/pdf-worker/runner.ts`, so that `'canonicalize'` uses `PDF_JOB_TIMEOUT_UPLOAD_MS` as `'inspect'` does.
- Test: `src/lib/pdf/canonicalize.test.ts`, `src/lib/pdf/canonical-result.test.ts`

**Interfaces:**
- Consumes: Task 1's checks; `loadPdfWithDecodeLimits`, `withPdfDecodeBudget`, `flattenPdfFormAppearances`, `assertSealCost`, `appendUprightPages`, `pageTreeLeaves` and `checkPdfStructure` (`src/lib/verify/pdf-structure.ts`).
- Produces:
  - `type CanonicalRefusalKey = 'need_appearances' | 'visible_annotations' | 'hidden_layers' | 'self_check' | 'unsupported_form' | 'no_pages' | 'unreadable_pdf' | 'pdf_too_complex'`.
  - `type CanonicalizeResult = { ok: true; bytes: Uint8Array; pageCount: number; sealCost: PdfSealCost } | { ok: false; key: CanonicalRefusalKey | 'encrypted'; message?: string }`. The `message` is used only for `unsupported_form`, through the existing pass-through rule.
  - `canonicalizeUploadedPdf(bytes: Uint8Array, opts?: { ignoreEncryption?: boolean }): Promise<CanonicalizeResult>`. Its steps, in order:
    1. `loadPdfWithDecodeLimits(bytes, { decodePageContents: true, ignoreEncryption })` in `'source'` mode. Errors map as `inspectUploadedPdf` maps them today.
    2. A page count of 0 → `no_pages`.
    3. `assertNoNeedAppearances`.
    4. `flattenPdfFormAppearances`. A failure maps to `unsupported_form` as today.
    5. `assertNoVisibleAnnotations`, then `optionalContentPolicy`.
    6. `PDFDocument.create({ updateMetadata: false })`, then `setProducer('DocuRidge')`.
    7. `appendUprightPages(out, source.getPages())` under the decode budget.
    8. `flush`, then `save({ useObjectStreams: false })`.
    9. The self-check: reload the bytes with `{ updateMetadata: false }`, `save({ useObjectStreams: false, updateFieldAppearances: false })`, and require identical bytes. Then `checkPdfStructure(bytes)`. A failure here → `self_check`.
    10. `sealCost = assertSealCost(reloaded)`.

    Steps 6–8 run with the seeded `Math.random` (see Global Constraints).
  - The job: `PdfJobInputMap.canonicalize = { bytes: Uint8Array; ignoreEncryption?: boolean }` and `PdfJobOutputMap.canonicalize = CanonicalizeResult`.
  - `parseCanonicalizeResult(x: unknown): CanonicalizeResult`, in `canonical-result.ts`. On an ok result it validates four things:
    - `bytes` is a `Uint8Array` that starts with `%PDF-`;
    - `0 < bytes.byteLength ≤ getPdfSealLimits().maxSealBytes`;
    - `pageCount` is a safe integer with `1 ≤ pageCount ≤ maxPages`;
    - `sealCost` is within the caps, with `sealCost.pages === pageCount`.

    On a refusal it accepts only a known `key`. Anything else is `{ ok: false, key: 'pdf_too_complex' }`.
  - `CANONICAL_REFUSAL_MESSAGES: Record<CanonicalRefusalKey, string>` and `canonicalRefusalUploadCode(key): UploadValidationCode`, both in `canonical-result.ts`, with the table in Global Constraints. Add `'unsupported_content'` to `UploadValidationCode` in `src/lib/storage.ts`.

- [ ] **Step 1: Write failing tests.**
  - `canonicalize.test.ts`:
    - `"is deterministic"`: canonicalizing the same input twice gives equal bytes. Run it on a form fixture whose flatten embeds Helvetica, and on a multi-page fixture.
    - `"output is a pdf-lib fixed point and passes checkPdfStructure"`.
    - `"has no annotations, no AcroForm, no OCProperties, no Outlines/Names/StructTreeRoot/Metadata, and Info is exactly /Producer (DocuRidge)"`.
    - `"page geometry"`: a page with `/Rotate 90`, a `/CropBox` inside a larger `/MediaBox` and `/UserUnit 2` becomes a page whose MediaBox is `[0 0 w h]`. Here `w` and `h` are the rotated crop size × 2, and the page has no `/Rotate` and no `/CropBox`.
    - `"under-reported /Count is refused"` and `"untyped kid is refused"`: the find_019pUbrXFsNQhGPYgxUwMpKb samples give `{ ok: false }`. Phase 1's source walk already refuses them; this pins it.
    - `"duplicate object definition"`: the find_01MPXLxm41G5RC1ojiExrcg4 sample (two `5 0 obj`, xref to the first) gives a canonical file in which object content appears once, and `checkPdfStructure` accepts it.
    - `"refusals map to keys"`: one fixture each for `need_appearances`, `visible_annotations` and `hidden_layers`.
    - `"an all-ON layered document is accepted without OCProperties"`.
    - `"an Acrobat-signed document is flattened to its appearance"`: the signature widget's appearance is drawn, and there is no `/Sig` field.
    - `"an encrypted upload reports encrypted"`.
    - `"seal cost is measured on the canonical file"`.
    - `"Math.random is restored"`.
  - `canonical-result.test.ts`: a valid result passes. Each of the following becomes `pdf_too_complex`: a missing `%PDF-` header, oversize bytes, a `pageCount` of 0, a `sealCost.pages` mismatch, and an unknown key. A child `message` on a `hidden_layers` refusal is dropped.
  - The canonicalize test also runs in process mode once: `"the canonicalize job runs in a real child"` (copy the pattern from `seal-worker.test.ts`).
- [ ] **Step 2:** Run `npx vitest run src/lib/pdf/canonicalize.test.ts src/lib/pdf/canonical-result.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the interfaces above.** Do not change `appendUprightPages` or `flattenPdfFormAppearances`: the canonical file must be what the seal pipeline produces today.
- [ ] **Step 4:** Run the same command, then `npm run build:pdf-worker` and `npx vitest run`. Expected: all PASS, and the bundle builds. The bundle now includes `pdf-structure.ts`; confirm it pulls in no `prisma`, `env` or `logger` with `grep -c "PrismaClient\|pino" dist/pdf-worker.cjs` (expected `0`).
- [ ] **Step 5: Commit** `feat(pdf): canonicalize uploads into the seal's own page layout`.

### Task 3: Storage, schema and upload

**Files:**
- Create: `prisma/migrations/20261025000000_document_file_canonical/migration.sql`
- Modify: `prisma/schema.prisma` (`DocumentFile`)
- Create: `src/lib/pdf/canonical-source.ts` (parent-side)
- Modify: `src/lib/storage.ts`, `src/lib/envelopes/service.ts` (`addEnvelopeFile`; remove `setEnvelopeItemPageCount`), `src/app/dashboard/envelopes/new/actions.ts`, `src/app/dashboard/envelopes/[id]/actions.ts` (clone)
- Test: `src/lib/pdf/canonical-source.test.ts`, `src/lib/storage.test.ts`, and the existing action and service tests

**Interfaces:**
- Consumes: Task 2's job, `parseCanonicalizeResult`, `CANONICAL_REFUSAL_MESSAGES` and `canonicalRefusalUploadCode`.
- Produces:
  - The columns, all nullable and additive: `canonicalStoragePath String?`, `canonicalSha256 String?`, `canonicalVersion Int?`, `canonicalPageCount Int?`, `canonicalSealCost Json?`, `canonicalRefusal String?`.
  - In `storage.ts`:
    - `writeCanonicalPdf(args: { orgId: string; bytes: Uint8Array }): Promise<{ relativePath: string; sha256: string; sizeBytes: number }>`.
    - `readCanonicalPdf(doc: { storagePath: string; sha256: string }): Promise<Buffer>`, where callers pass a `CanonicalDocument`. It throws `CanonicalUnavailableError` (exported) when the read fails or the hash does not match.
    - `canonicalizeInWorker(bytes: Uint8Array, opts?: { ignoreEncryption?: boolean }): Promise<CanonicalizeResult>`. It replaces `inspectInWorker` and maps worker failures the same way: `busy`/`unavailable` throw `UploadValidationError('busy', …)`; any other worker failure, or a child `fail`, is `pdf_too_complex` or `unreadable_pdf` as today.
  - `saveUploadedPdf` now returns `StoredFile & { canonical: { relativePath: string; sha256: string; pageCount: number; sealCost: PdfSealCost } }`. The encrypted path is unchanged: canonicalize, then qpdf in the parent, then canonicalize the decrypted bytes. A refusal throws `UploadValidationError(canonicalRefusalUploadCode(key), CANONICAL_REFUSAL_MESSAGES[key])`. The `unsupported_form` pass-through keeps working.
  - In `canonical-source.ts`:
    - `CURRENT_CANONICAL_VERSION = 1`.
    - `interface CanonicalDocument { documentFileId: string; storagePath: string; sha256: string; pageCount: number; sealCost: PdfSealCost }`.
    - `class CanonicalRefusedError extends Error { readonly key: CanonicalRefusalKey }`, whose message is `CANONICAL_REFUSAL_MESSAGES[key]`.
    - `ensureCanonicalDocument(documentFileId: string): Promise<CanonicalDocument>`. A row that already has a canonical copy is returned without a job. A row with `canonicalRefusal` set throws `CanonicalRefusedError` without a job. Otherwise it does three things:
      1. reads the original and runs `canonicalizeInWorker(bytes, { ignoreEncryption: true })` (legacy rows may predate decryption at upload);
      2. on success, writes the file, then `updateMany({ where: { id, canonicalSha256: null }, data: {...} })`, and re-reads the row, so a concurrent winner's values are returned;
      3. on a refusal, stores `canonicalRefusal = key` (and `canonicalVersion`) and throws.

      `busy` and `unavailable` propagate as `PdfWorkerError` and are never stored.
    - `ensureEnvelopeCanonical(items: ReadonlyArray<{ title: string; documentFileId: string }>): Promise<CanonicalDocument[]>`, in item order.
  - `addEnvelopeFile` writes all canonical columns from `saveUploadedPdf`'s result on the new `DocumentFile`, and `pageCount: stored.canonical.pageCount` on the new `EnvelopeItem`.
  - `createAndSendEnvelopeAction` checks each field's `page` against the stored item `pageCount`, after upload. A mismatch returns the existing `Field on page … but that document has … pages.` error, using the server count.

- [ ] **Step 1: Write failing tests.**
  - `storage.test.ts`:
    - `"saveUploadedPdf stores the original and a canonical copy"`: both files exist at their paths, the canonical sha256 matches its bytes, and the file is mode 0600.
    - `"an encrypted upload is canonicalized from the decrypted bytes"` (Review Focus 5).
    - `"a busy worker stores nothing"`: mock the runner to throw `PdfWorkerError('busy')`. Expect `UploadValidationError` code `busy`, and an uploads directory that is still empty.
    - `"a visible-annotation upload is refused with the fixed message"`.
    - `"readCanonicalPdf refuses a file whose bytes no longer match"`.
  - `canonical-source.test.ts` (real database, as the other service tests use):
    - `"canonicalizes a legacy row on demand and stores the columns"`.
    - `"returns the stored copy without a job"`: spy on `runPdfJob`, expect 0 calls.
    - `"stores a refusal and does not retry it"`: the second call throws `CanonicalRefusedError` with 0 jobs.
    - `"busy is not stored"`.
    - `"two concurrent calls for one row both succeed with one canonical"` (Review Focus 3): `Promise.all` of two calls gives equal results, one `canonicalSha256`, and one file in `<org>/canonical/`.
  - Action and service tests:
    - `"page count comes from the canonical file, not the client"`: submit `pageCount: 7` for a 2-page PDF. The item has `pageCount === 2`. A field on page 3 is refused with the server count in the message.
    - Remove the tests of `setEnvelopeItemPageCount`.
- [ ] **Step 2:** Run `npx prisma migrate dev --name document_file_canonical --create-only`. Rename the folder to the path above if Prisma chose another timestamp, and check that the SQL is `ALTER TABLE "document_file" ADD COLUMN …` only. Then run the tests above. Expected: FAIL.
- [ ] **Step 3: Implement the interfaces above.** `inspectInWorker`'s callers move to `canonicalizeInWorker`, and `inspectInWorker` is deleted. `runInspectJob` stays until Task 4 moves the send-time check. Until then, `addEnvelopeFile` passes `stored.canonical.sealCost` to `rememberSealCost` and `assertEnvelopeItemsSealable`, where it passed `stored.sealCost` before.
- [ ] **Step 4:** Run `npx prisma migrate deploy` against the test database, then `npx vitest run`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(upload): store a canonical copy of every upload and take page counts from it`.

### Task 4: The send-time check reads the database

**Files:**
- Modify: `src/lib/pdf/envelope-seal-check.ts`, `src/lib/envelopes/service.ts`, `src/lib/envelopes/lifecycle.ts` (`sendEnvelope`'s item select), `src/lib/templates/service.ts`
- Modify: `src/app/dashboard/templates/[id]/page.tsx` (refusal flag)
- Delete: the `'inspect'` job (`protocol.ts`, `jobs.ts`), `runInspectJob` (`storage.ts`) and `inspectUploadedPdf` (`inspect-upload.ts`). Keep that file's messages and types, which `canonical-result.ts` reuses, or move them there.
- Test: `src/lib/pdf/envelope-seal-check.test.ts`, `src/lib/templates/service.test.ts`, and a page test for the template flag

**Interfaces:**
- Consumes: `ensureEnvelopeCanonical` and `CanonicalRefusedError` (Task 3).
- Produces:
  - `SealCheckItem` becomes `{ title: string; documentFileId: string }`.
  - `assertEnvelopeItemsSealable(items, extra?)` keeps its signature otherwise. Each item's cost is `ensureCanonicalDocument(...).sealCost`, with three mappings:
    - `CanonicalRefusedError` → `EnvelopeNotSealableError` with the message `"${title}" can't be sent: ${refusal message}`;
    - `CanonicalUnavailableError` → `"${title}" could not be read, so it could not be sealed. Replace it before sending.`;
    - `PdfWorkerError` `busy`/`unavailable` → the existing retryable busy error.
  - The in-memory cost cache, `rememberSealCost` and `clearSealCostCache` are deleted, along with their callers.
  - The template page shows, for each item whose `documentFile.canonicalRefusal` is set: `This document can't be used for signing: ${message} Upload a replacement to use this template.`

- [ ] **Step 1: Write failing tests.**
  - `envelope-seal-check.test.ts`:
    - `"reads the stored cost without a worker job"`: spy on `runPdfJob`, expect 0 calls for items that already have a canonical copy.
    - `"canonicalizes a legacy item at send"`.
    - `"a refused item names the document and the reason"`.
    - `"busy is retryable"`.
  - `templates/service.test.ts`: `"instantiating a template whose document has hidden layers is refused before any envelope is sent"`. This is the send-time half of find_01SNv2YpN7XQmYGvuQhLBJCs's fix criteria (template and public-form items).
  - Template page test: a refused item shows the flag text.
- [ ] **Step 2:** Run `npx vitest run src/lib/pdf/envelope-seal-check.test.ts src/lib/templates/service.test.ts` and the page test. Expected: FAIL.
- [ ] **Step 3: Implement the interfaces above.**
- [ ] **Step 4:** Run `npx vitest run`, then `npm run build:pdf-worker`. Expected: all PASS. Then `grep -c inspectUploadedPdf dist/pdf-worker.cjs`; expected `0`.
- [ ] **Step 5: Commit** `refactor(send): read seal cost from the canonical row instead of re-parsing`.

### Task 5: Serve the canonical file

Completes find_019pUbrXFsNQhGPYgxUwMpKb, find_01MPXLxm41G5RC1ojiExrcg4, find_016H3wUkTnARCoD3T3mghHw6 (missing-`/AP` case), find_01FS1qr8YPoZGndLMnzv6uu5 and find_01SNv2YpN7XQmYGvuQhLBJCs: the signer sees exactly what the seal starts from.

**Files:**
- Modify: `src/app/sign/[token]/document/route.ts`, `src/app/dashboard/envelopes/[id]/document/route.ts`, `src/app/api/v1/envelopes/[id]/documents/[documentId]/route.ts`, `src/lib/api/serializers.ts`
- Test: the existing route tests next to each route (create `route.test.ts` where none exists, following `src/app/sign/[token]/document/` tests from the earlier multi-document fix)

**Interfaces:**
- Consumes: `ensureCanonicalDocument`, `readCanonicalPdf`, `CanonicalRefusedError` and `CanonicalUnavailableError`.
- Produces:
  - **Sign route.** It loads the item, runs `ensureCanonicalDocument(item.documentFileId)`, then `readCanonicalPdf`.
    - A refusal or unavailable copy → 409, body `This document can't be shown right now. Contact the sender.`
    - Busy → 503 with `Retry-After: 30`.
    - It never reads the original.
  - **Dashboard route.**
    - The sealed file, unless `?original=1`.
    - Otherwise the canonical copy of `?item=N`, with the same error mapping as the sign route.
    - `?upload=1` returns the original bytes, for the sender only, as the route already requires.
  - **API download.** Canonical by default, the original with `?original=1`; both are audited as today. `serializeDocument` adds `canonicalSha256: string | null`.

- [ ] **Step 1: Write failing tests.**
  - Sign route:
    - `"serves the canonical bytes, never the original"`: the body's sha256 equals `canonicalSha256` and differs from `sha256`.
    - `"a refused legacy document answers 409 and never serves the original"` (Review Focus 1).
    - `"a canonical file whose bytes changed answers 409"` (Review Focus 4).
    - `"busy answers 503"`.
    - `"missing /AP text field: the served file shows the generated appearance"`. Upload the finding's no-`/AP` form, fetch it through the sign route, and assert the served file's page content draws the field value through a Form XObject. This is the second case in find_016H3wUkTnARCoD3T3mghHw6.
  - Dashboard route: default before sealing is canonical; `?upload=1` returns the original; after sealing, the default is the sealed file and `?original=1` returns canonical.
  - API: default is canonical, `?original=1` returns the original, and the serializer has `canonicalSha256`.
- [ ] **Step 2:** Run the route tests. Expected: FAIL.
- [ ] **Step 3: Implement the interfaces above.**
- [ ] **Step 4:** Run `npx vitest run`, then the isolated e2e suite. Expected: all PASS. The e2e signing flows now render canonical files.
- [ ] **Step 5: Commit** `feat(sign): show signers the canonical document`.

### Task 6: Seal from the canonical file

**Files:**
- Modify: `src/lib/pdf/seal.ts` (`sealRenderInput`, `buildManifest`, `AuditPageData` items), `src/lib/pdf/seal-render.ts` (item loop, audit page), `src/lib/verify/sealed-pdf.ts` (manifest document type: optional `canonicalSha256`), `scripts/verify.ts` (print it when present)
- Test: `src/lib/pdf/seal-canonical.test.ts`, plus the existing seal tests updated to use canonicalized fixtures

**Interfaces:**
- Consumes: `ensureEnvelopeCanonical`, `readCanonicalPdf` and the canonical columns.
- Produces:
  - `sealRenderInput` runs `ensureEnvelopeCanonical(env.items)` and then sends each item's **canonical** bytes, read with `readCanonicalPdf`.
    - `CanonicalRefusedError` and `CanonicalUnavailableError` become `SealedContentStructureError` with the fixed message `"${title}" could not be prepared for sealing. Replace the document and send it again.` That makes it not retryable, through the existing mapping.
    - `PdfWorkerError` propagates as today (busy stays retryable).
  - `seal-render.ts` does the following for each item:
    1. `checkPdfStructure(item.bytes)`;
    2. `loadPdfWithDecodeLimits(item.bytes, { pageTreeMode: 'sealed' })`;
    3. `assertSealCost`;
    4. `out.copyPages(source, indices)`, with each page added by `out.addPage`;
    5. stamp the fields.

    There is no `flattenPdfFormAppearances` and no `appendUprightPages` in the seal any more. `sourceStep` still wraps the load and the copy.
  - The manifest's `documents[]` gains `canonicalSha256` (from the row). `version` stays `3`. The audit page lists, under each document, `Signed copy SHA-256: ${canonicalSha256}` after the existing source hash line.

- [ ] **Step 1: Write failing tests** in `seal-canonical.test.ts` (inline mode).
  - `"the sealed page draws the canonical page's content unchanged"`. For each page, the Form XObject that the sealed page's first content stream draws has the same stream bytes and the same `/BBox`/`/Matrix` as the one in the canonical file, and the stamp operators come after it.
  - `"stamps land where they did before"` (Review Focus 2). For the rotated, cropped, UserUnit fixture from Task 2, the sealed page size and a SIGNATURE field's drawn rectangle equal the values computed with `uiToPdf` on the canonical page size. Compare against literal numbers derived in the test.
  - `"the seal refuses a canonical file that is not a single-revision pdf-lib file"`. Append an incremental update to the stored canonical file and fix its row hash to match. Sealing fails with `SealedContentStructureError`, and `completeRecipientSigning` records `envelope.seal_failed`, not retryable, with the signature kept (Review Focus 1, 4).
  - `"a missing canonical file fails the seal, not retryable"`.
  - `"the manifest records canonicalSha256 and the result verifies"`: `verifySealedPdf` with the fixture key returns ok.
  - `"a legacy item without a canonical copy is canonicalized at seal time"`.
- [ ] **Step 2:** Run `npx vitest run src/lib/pdf/seal-canonical.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the interfaces above.** Update the existing seal fixtures (`seal.test.ts`, `seal-chain.test.ts`, `seal-persist.test.ts`, `seal-images.test.ts`, `seal-worker.test.ts`) to create `DocumentFile` rows with canonical copies. Use a shared helper in the existing test harness that calls `canonicalizeUploadedPdf` and `writeCanonicalPdf`.
- [ ] **Step 4:** Run `npx vitest run`, `npm run build:pdf-worker`, then the isolated e2e suite. Expected: all PASS, with every e2e seal built from canonical files. Run `npm run verify` on one e2e-produced seal. Expected: exit 0.
- [ ] **Step 5: Commit** `feat(seal): build seals from the canonical document`.

### Task 7: Backfill script and image

**Files:**
- Create: `scripts/canonical-backfill.ts`
- Modify: `package.json`. Add `"build:canonical-backfill": "esbuild scripts/canonical-backfill.ts --bundle --platform=node --target=node22 --format=cjs --outfile=dist/canonical-backfill.cjs --external:@prisma/client --external:.prisma"`, and run it from `"build"`.
- Modify: `Dockerfile`. Copy `dist/canonical-backfill.cjs` to `/app/canonical-backfill.cjs`, root-owned, mode 0644, like the worker bundle.
- Modify: `DEPLOYMENT.md`, adding a "Canonical documents (2026-10)" section with the command and how to read the report.
- Test: `scripts/canonical-backfill.test.ts`

**Interfaces:**
- Produces: `node /app/canonical-backfill.cjs [--dry-run] [--retry-refused] [--recanonicalize]`, run from `/app`. Its behaviour:
  - It selects every `DocumentFile` referenced by at least one `EnvelopeItem`. Sealed outputs, which have no item, are skipped.
  - It runs `ensureCanonicalDocument` on each row, one at a time.
    - `--retry-refused` clears `canonicalRefusal` first.
    - `--recanonicalize` also redoes rows whose `canonicalVersion < CURRENT_CANONICAL_VERSION`.
    - `--dry-run` canonicalizes in the worker but writes no file and no row.
  - For any item whose `pageCount` differs from `canonicalPageCount`, it sets `pageCount` to the canonical count and reports the item. It also reports any field whose `page` exceeds the new count.
  - The report goes to stdout as one JSON line per row. Its fields are:
    - `documentFileId`, `status` (`ok` | `already` | `refused` | `busy` | `error`), `key?`;
    - `items: [{ envelopeId, status, title }]`, so a refused document in a SENT or IN_PROGRESS envelope is visible;
    - `pageCountFixed?`.

    A final summary line follows. The exit code is non-zero if any row ended `busy` or `error`.
  - It prints no PDF content and no sha256 of an original. Ids and titles only.

- [ ] **Step 1: Write a failing test** in `canonical-backfill.test.ts`. Export the script's `main(argv)` and test it against the test database. Seed three rows: a legacy row without a canonical copy, one that already has one, and one with hidden layers inside a SENT envelope. Expect statuses `ok`, `already` and `refused`, with the refused row listing its envelope. A second run does 0 jobs. `--dry-run` writes nothing.
- [ ] **Step 2:** Run `npx vitest run scripts/canonical-backfill.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the script.** The bundle runs in the production image with only `node_modules/@prisma`, `node_modules/.prisma` and `/app/pdf-worker.cjs`. `resolvePdfWorkerEntry` finds the worker through `process.cwd()`, so the documented command runs from `/app`.
- [ ] **Step 4:** Run `npx vitest run`, then `npm run build`. Rebuild the e2e image with the scratch override and run `docker exec docuridge_e2e_app sh -c 'cd /app && node canonical-backfill.cjs --dry-run'`. Expected: a summary line and exit 0. Then run the isolated e2e suite. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(ops): bundled backfill for canonical documents`.

### Task 8: Phase acceptance

**Files:** none in the repo. Scratch scripts go in a scratch directory outside the repo. Production data is read in place, read-only. Any rendered output or copy goes in a `chmod 700` scratch directory that is deleted afterwards.

- [ ] **Step 1: Corpus check.** Run every production upload through `canonicalizeUploadedPdf` in process mode. For each file that is accepted, render the original and the canonical copy with `pdftoppm -r 30 -gray` and compare pixels.
  - Expected: the same accepted count as phase 1's inspect (75 ok, 2 `unsupported_form`).
  - Expected: zero differing pixels.
  - A file with any difference is rendered at 100 dpi side by side and examined by eye, and listed in the report with its pixel count.
  - The check also lists every refused file and the envelopes, with their status, that use it.
- [ ] **Step 2: Seal check.**
  - Build seals in inline mode from canonical copies of three production COMPLETED envelopes' inputs, and verify them with `npm run verify`. Expected: exit 0.
  - Confirm all 41 existing seals still verify. Expected: 41/41. The verifier is unchanged in this phase; this pins it.
- [ ] **Step 3: Regression map.** Each finding must have its test passing:

  | Finding | Tests |
  |---|---|
  | find_019pUbrXFsNQhGPYgxUwMpKb | `canonicalize.test.ts` `/Count` and untyped kid; sign route serves canonical |
  | find_01MPXLxm41G5RC1ojiExrcg4 | `canonicalize.test.ts` duplicate object; sign route serves canonical; `seal-canonical.test.ts` content identity |
  | find_016H3wUkTnARCoD3T3mghHw6 | `source-policy.test.ts` NeedAppearances; sign route missing-`/AP` case |
  | find_01FS1qr8YPoZGndLMnzv6uu5 | `source-policy.test.ts` Square annotation; template send refusal |
  | find_01SNv2YpN7XQmYGvuQhLBJCs | `source-policy.test.ts` OFF layer; `templates/service.test.ts` hidden layers |

- [ ] **Step 4: Full checks.** Run `npx tsc --noEmit`, `npm run lint` (0 errors), `npx vitest run`, then rebuild the e2e stack with the scratch override and run `npm run test:e2e:isolated`. Expected: all pass, with at least 97 e2e passing.
- [ ] **Step 5: Independent review.** Run the `signing-security-reviewer` and `pdf-render-reviewer` agents on the branch diff, fix what they confirm, and re-run Step 4.
- [ ] **Step 6: Hand to the user** for push, deploy and finding resolution. Deploy is the established procedure plus two steps:
  - run `prisma migrate deploy` (the entrypoint does this);
  - run `docker exec docuridge_app sh -c 'cd /app && node canonical-backfill.cjs'` after the app is healthy, and review its report before resolving findings.
