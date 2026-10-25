# PDF isolation and caps (phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all server-side parsing of untrusted PDFs into a disposable, memory- and time-capped child process. Refuse dangerous files before pdf-lib walks them. Bound the cost of stamped images and fields.

**Architecture:** A job runner (`src/lib/pdf-worker/`) forks one Node child per job. The child has a heap cap, a wall-clock limit and a minimal environment, and receives bytes, not paths or credentials. Three call sites use it: upload inspection (`saveUploadedPdf`), the send-time measurement (`envelope-seal-check`) and the seal render (`buildSealedEnvelope`). The seal's DB reads, org key and manifest signing stay in the parent; the child asks the parent for the signed manifest over IPC. Every pdf-lib load now runs a byte-level object ceiling and the strict page-tree walk before anything calls `getPages()`.

**Tech Stack:** Node 22, TypeScript, pdf-lib 1.17, `child_process.fork` with `serialization: 'advanced'`, esbuild for the worker bundle, vitest.

**Spec:** `docs/superpowers/specs/2026-10-24-pdf-canonical-source-and-isolation-design.md` (§1, §2 step 1, §4). Phases 2 and 3 get their own plans.

## Global Constraints

- **The repo is public.** Never write this host's production or tailnet names, or any part of them, into a file or commit message. Before every commit, run the host-name check from your brief on `git diff --cached` and the message, and require no output.
- **Commit identity** is `umzcio <umzcio@users.noreply.github.com>` (already the repo-local config). End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **The child gets no secrets.** Its environment is an allowlist: `NODE_ENV`, `TZ`, and every variable whose name starts with `PDF_` or is one of `MAX_IMAGE_DIMENSION`, `MAX_IMAGE_PIXELS`, `MAX_SIGNATURE_IMAGE_BYTES`, `SEAL_MAX_IMAGE_PIXELS`. The child does no DB access and no filesystem reads of user data.
- **One process per job.** Never reuse a child for a second job (pdf-lib's `PDFName`/`PDFRef` pools only reset when the process ends).
- **New defaults**, all overridable by environment:

  | Variable | Default |
  |---|---|
  | `PDF_WORKER_HEAP_MB` | 512 |
  | `PDF_WORKER_CONCURRENCY` | 2 |
  | `PDF_WORKER_QUEUE_MS` | 30000 |
  | `PDF_JOB_TIMEOUT_UPLOAD_MS` | 30000 |
  | `PDF_JOB_TIMEOUT_SEAL_MS` | 60000 |
  | `PDF_MAX_PARSE_OBJECTS` | 1000000 |
  | `SEAL_MAX_IMAGE_PIXELS` | 67108864 (64 MP, distinct images per sealed envelope) |
  | `ENVELOPE_MAX_FIELDS` | 2000 |
  | `ENVELOPE_MAX_FIELDS_PER_PAGE` | 200 |

- **Unit tests run jobs inline.** Under vitest, `PDF_WORKER_MODE=inline` (set in `vitest.config.ts` `test.env`) runs job handlers in-process through the same API. Only `src/lib/pdf-worker/*.test.ts` and the one seal integration test force `process` mode.
- **The full unit suite, `npm run lint` (0 errors), `npx tsc --noEmit` and the isolated e2e suite pass at the end of every task that touches runtime code.** The e2e command is `npm run test:e2e:isolated`, run against a stack built with the scratch override `e2e-image.yml`, which sets `image: docuridge_e2e_app:latest`. Never rebuild or retag `docuridge_app:latest` for tests.
- **`grep` and `seal.ts`.** `src/lib/pdf/seal.ts` contains a byte that makes the shell's `grep` treat it as binary. Use `grep -a` on it.

## Review Focus

1. **The worker queue is full when the last signer submits.** Completion must record `envelope.seal_failed` (retryable), keep every signature, and answer the signer cleanly, never lose the signature or hang. Test in Task 6.
2. **The worker bundle is missing from the production image.** Every upload would fail. `/readyz` must report not-ready when the worker entry cannot be resolved. Test in Task 3.
3. **The child exits mid-job, or writes to stdout or stderr.** The runner must reject with `crashed` and never wait forever on a partial IPC exchange. Test in Task 3.
4. **An encrypted upload.** qpdf decryption runs in the parent between two inspection jobs, and the stored bytes are the decrypted ones, as today. Test in Task 4.
5. **A 25 MB upload goes over IPC.** The buffer must round-trip intact and within the upload time limit. Test in Task 3.

---

### Task 1: Pre-parse guards on every pdf-lib load

Closes find_012oW2gLvKuBSGqip2Sx1Ngj, and the pre-parse ceiling part of find_014hWbSvUmef3cauRsRtCiR5.

**Files:**
- Create: `src/lib/pdf/page-tree.ts` (move `pageTreeLeaves` here from `content-digest.ts`; `content-digest.ts` re-exports it)
- Create: `src/lib/pdf/object-ceiling.ts`
- Modify: `src/lib/pdf/decode-limits.ts` (`loadPdfWithDecodeLimits`, `decodeAllPageContents`)
- Modify: `src/lib/pdf/seal-limits.ts` (add `'parse_objects'` to `PdfComplexityLimit`)
- Test: `src/lib/pdf/page-tree.test.ts`, `src/lib/pdf/object-ceiling.test.ts`, `src/lib/pdf/decode-limits.test.ts`

**Interfaces:**
- Produces:
  - `pageTreeLeaves(doc: PDFDocument, opts?: { maxPages?: number }): PDFDict[]`. It behaves as today, but goes over `maxPages`, which throws `PdfComplexityError('pages', ...)`. The depth limit stays at 64.
  - `countDeclaredObjects(bytes: Uint8Array): number`. This is a deliberate over-count of top-level definitions only: every `obj` keyword not preceded by `end`, after `#xx` name escapes are normalised. *As built (ruling R11):* object-stream members are not counted by text, because every attempt to do that could be bypassed. Instead `withParseObjectCeiling` counts every object pdf-lib registers during `PDFDocument.load` (a hook on `PDFContext.assign`), and refuses an object stream whose `/N` would pass the ceiling before its offset table is built.
  - `assertParseObjectCeiling(bytes: Uint8Array, max = getParseObjectCeiling()): void`, which throws `PdfComplexityError('parse_objects', ...)`.
  - `getParseObjectCeiling(): number`, reading `PDF_MAX_PARSE_OBJECTS` (default 1_000_000).
  - `loadPdfWithDecodeLimits` now does three things in order: `assertParseObjectCeiling(bytes)` before `PDFDocument.load`, `pageTreeLeaves(doc, { maxPages: getPdfSealLimits().maxPages })` straight after it, and only then anything else. `decodeAllPageContents` iterates the leaves it is given, not `doc.getPages()`.

- [ ] **Step 1: Write failing tests.**
  - `page-tree.test.ts` "refuses a shared-node page tree in linear time". Build a PDF with pdf-lib whose `/Pages` root has 2 kids pointing at the same `/Pages` node, nested 30 levels (2^30 leaves). `pageTreeLeaves` throws `SealedContentStructureError` matching `/more than once/`, and takes under 200 ms.
  - "refuses an under-reported /Count": throws `/Count of/`.
  - "refuses an untyped kid": throws `/neither a \/Type \/Page/`.
  - "refuses more pages than maxPages": a 3-page doc with `{ maxPages: 2 }` throws `PdfComplexityError` with `limit === 'pages'`.
  - `object-ceiling.test.ts` "counts classic and object-stream definitions": the `bomb-pdf.ts` fixture's object-stream case reports its `/N`. "refuses past the ceiling without parsing": a synthetic 1_000_001-definition buffer throws with `limit === 'parse_objects'` in under 1 s, and `PDFDocument.load` is never called (spy).
  - `decode-limits.test.ts` "loadPdfWithDecodeLimits refuses the shared-node tree before getPages": spy on `PDFDocument.prototype.getPages`, expect 0 calls and a thrown `SealedContentStructureError`.
- [ ] **Step 2:** Run `npx vitest run src/lib/pdf/page-tree.test.ts src/lib/pdf/object-ceiling.test.ts src/lib/pdf/decode-limits.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement the interfaces above.** The 2^30 fixture must be built with low-level `doc.context` objects (a `PDFDict` per node), not `addPage`.
- [ ] **Step 4:** Run the same command plus `npx vitest run src/lib/pdf src/lib/verify src/lib/storage.test.ts`. Expected: all PASS. Existing seal and verify fixtures pass the strict walk; production uploads already do (checked 2026-10-24: 77/77).
- [ ] **Step 5: Commit** `fix(pdf): refuse shared page trees and object floods before pdf-lib walks them`.

### Task 2: Distinct-image embedding, image pixel budget, field caps

Closes find_014Jf4kxPMfbhPsDbuuNFqkC.

**Files:**
- Create: `src/lib/envelopes/field-caps.ts`
- Modify: `src/lib/signing/signature-image.ts` (pixel budget)
- Modify: `src/lib/pdf/seal.ts` (`stampField` and the item loop, at the three `embedStoredImage` call sites: lines ~404, ~517, ~548)
- Modify: `src/app/dashboard/envelopes/new/actions.ts` (field arrays), `src/lib/envelopes/service.ts` (`addField`), `src/lib/envelopes/lifecycle.ts` (`sendEnvelope`), `src/lib/templates/service.ts` (`instantiateTemplate`)
- Test: `src/lib/envelopes/field-caps.test.ts`, `src/lib/pdf/seal-images.test.ts`, plus additions to the existing action and service tests

**Interfaces:**
- Produces:
  - `getFieldCaps(): { perEnvelope: number; perPage: number }`, from `ENVELOPE_MAX_FIELDS` and `ENVELOPE_MAX_FIELDS_PER_PAGE`.
  - `class FieldCapError extends Error`. Message for the envelope cap: `An envelope can have at most ${perEnvelope} fields.` For the page cap: `A page can have at most ${perPage} fields.`
  - `assertFieldCaps(fields: ReadonlyArray<{ document: string | number; page: number }>, caps = getFieldCaps()): void`.
  - `type ImageEmbedCache = Map<string, Promise<PDFImage>>`.
  - `embedCachedImage(doc: PDFDocument, base64: string, formats: EmbeddableImageFormat[], cache: ImageEmbedCache): Promise<PDFImage>`. The key is `${formats.join(',')}:${sha256(base64)}`.
  - `assertSealImagePixels(images: Iterable<string>, max = getSealImagePixelLimit()): void`. It sums `width*height` of **distinct** base64 images via `inspectEmbeddableImageBytes` and throws `PdfComplexityError('seal_image_pixels', ...)`. Add that value to `PdfComplexityLimit`.
  - `getSealImagePixelLimit(): number`.

- [ ] **Step 1: Write failing tests.**
  - `seal-images.test.ts` "decodes one image once however many fields draw it": an envelope (use the existing `seal.test.ts` harness) with 3000 SIGNATURE fields for one recipient whose signature is an 8 MP PNG. Spy on `PDFDocument.prototype.embedPng`; expect it to be called exactly 1 time, and the sealed output to contain exactly one image XObject.
  - "refuses distinct images over the pixel budget": nine distinct 8 MP PNGs across recipients throw `PdfComplexityError` with `limit === 'seal_image_pixels'` before any page is embedded.
  - `field-caps.test.ts`: at 2000 fields across pages it passes; at 2001 it throws the envelope message. At 201 fields on one page of one document it throws the page message. At 200 fields on page 1 of each of two documents it passes.
  - In the action and service tests: `createAndSendEnvelopeAction` with 2001 fields returns `{ ok: false, error: 'An envelope can have at most 2000 fields.' }`. `addField` at the cap throws `FieldCapError`. `sendEnvelope` on an envelope holding 2001 fields (rows inserted directly, as a template or API instance would hold them) throws `FieldCapError`, and nothing is sent. `instantiateTemplate` of a 2001-field template throws.
- [ ] **Step 2:** Run `npx vitest run src/lib/envelopes/field-caps.test.ts src/lib/pdf/seal-images.test.ts` plus the touched action and service test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The cache is created once per `buildSealedEnvelope` call and passed to every `stampField`.
  - `assertSealImagePixels` runs over every Signature row image, DRAWING value and STAMP `meta.stampImageBase64` before the item loop.
  - In `new/actions.ts`, `document` is the field's document index; in DB call sites it is `envelopeItemId`.
- [ ] **Step 4:** Run the same tests, then `npx vitest run`. Expected: all PASS.
- [ ] **Step 5: Commit** `fix(seal): embed each image once, cap image pixels and fields per envelope`.

### Task 3: The PDF worker runtime

Closes the process-isolation part of find_014hWbSvUmef3cauRsRtCiR5.

**Files:**
- Create: `src/lib/pdf-worker/protocol.ts`, `src/lib/pdf-worker/runner.ts`, `src/lib/pdf-worker/child.ts`, `src/lib/pdf-worker/jobs.ts`, `src/lib/pdf-worker/errors.ts`
- Modify: `package.json` (add `esbuild` to devDependencies at the version `tsx` already installs, add `"build:pdf-worker": "esbuild src/lib/pdf-worker/child.ts --bundle --platform=node --target=node22 --format=cjs --outfile=dist/pdf-worker.cjs"`, and run it from `"build"`)
- Modify: `Dockerfile` (copy `dist/pdf-worker.cjs` to `/app/pdf-worker.cjs` in the run stage)
- Modify: `docker-compose.yml` (`mem_limit: 2g` on `app`)
- Modify: `vitest.config.ts` (`test.env.PDF_WORKER_MODE = 'inline'`)
- Modify: `src/app/readyz/route.ts`
- Modify: `.gitignore` (add `dist/`)
- Test: `src/lib/pdf-worker/runner.test.ts`, `src/app/readyz/route.test.ts`

**Interfaces:**
- Produces:
  - `type PdfJobKind = 'inspect' | 'seal' | 'diagnostic'`.
  - `PdfJobInput<K>` / `PdfJobOutput<K>`, mapped types in `protocol.ts`. `'inspect'` and `'seal'` are filled in by Tasks 4 and 6.
  - `'diagnostic'` input is `{ op: 'echo'; bytes: Uint8Array } | { op: 'spin' } | { op: 'allocate' } | { op: 'exit'; code: number } | { op: 'env' } | { op: 'pid' } | { op: 'ask'; question: string }`. Its handler is registered only when `PDF_WORKER_DIAGNOSTICS === '1'`.
  - `runPdfJob<K extends PdfJobKind>(kind: K, input: PdfJobInput<K>, opts?: { timeoutMs?: number; heapMb?: number; onRequest?: (req: unknown) => Promise<unknown> }): Promise<PdfJobOutput<K>>`.
  - `class PdfWorkerError extends Error { reason: 'timeout' | 'out_of_memory' | 'crashed' | 'busy' | 'unavailable' }`.
  - `resolvePdfWorkerEntry(): { file: string; execArgv: string[] } | null`. The order is: `PDF_WORKER_ENTRY`, then `${process.cwd()}/pdf-worker.cjs`, then (dev and test only) `src/lib/pdf-worker/child.ts` with `['--import', 'tsx']`.
  - `isPdfWorkerAvailable(): boolean`.
  - Job errors cross the boundary as `{ name, message, limit?, code? }`. The runner rebuilds `PdfComplexityError`, `PdfDecodeLimitError` and `SealedContentStructureError` with the same `limit`/`code`. Anything else becomes a plain `Error` with the message.
  - The IPC request/reply pair for `onRequest` is `{ t: 'req', id, body }` → `{ t: 'res', id, body | error }`. The child side is `askParent(body: unknown): Promise<unknown>`, exported from `child.ts`.
- Child exit mapping:
  - a V8 heap OOM (exit before a result, with stderr containing `heap out of memory` or signal `SIGABRT`/exit code 134) → `out_of_memory`;
  - a timeout → `SIGKILL`, then `timeout`;
  - any other exit or disconnect before a result → `crashed`;
  - a queue wait over `PDF_WORKER_QUEUE_MS` → `busy`;
  - no entry → `unavailable`.

- [ ] **Step 1: Write failing tests** in `runner.test.ts`. They run in `process` mode with `PDF_WORKER_DIAGNOSTICS=1`, using `--import tsx` on the `.ts` entry.
  - "round-trips a 25 MB buffer": echo returns identical bytes in under 10 s.
  - "kills a job at its time limit": `spin` with `timeoutMs: 1000` rejects with `reason: 'timeout'` in under 2500 ms, and the parent event loop stays responsive (a 10 ms interval keeps firing).
  - "reports out of memory": `allocate` with `heapMb: 64` rejects with `reason: 'out_of_memory'`.
  - "reports a crash": `exit` with code 3 rejects with `reason: 'crashed'`.
  - "never passes secrets": with `DATABASE_URL`, `SESSION_SECRET`, `JWS_SIGNING_TOKEN_SECRET` and `KEYS_DIR` set in the parent, `env` returns none of them, and does return `PDF_MAX_PAGES` when it is set.
  - "uses a fresh process per job": two `pid` jobs return different pids.
  - "answers child requests": `ask` with `onRequest: async (q) => q + '!'` returns `'hi!'`.
  - "queues beyond concurrency and refuses after the queue limit": with `PDF_WORKER_CONCURRENCY=1` and `PDF_WORKER_QUEUE_MS=300`, a 1 s spin plus a second job: the second rejects `busy`.
  - `readyz` test: with `resolvePdfWorkerEntry` mocked to return `null`, it answers 503 with body mentioning `pdf worker`.
- [ ] **Step 2:** Run `npx vitest run src/lib/pdf-worker src/app/readyz`. Expected: FAIL.
- [ ] **Step 3: Implement.** `inline` mode calls the registered handler directly, with the same error serialization round trip, so tests see the same error classes.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then run `npm run build:pdf-worker`. Expected: `dist/pdf-worker.cjs` exists and `node dist/pdf-worker.cjs` exits non-zero with "must be started by the PDF worker runner" when run without IPC.
- [ ] **Step 5:** Build the e2e image (scratch override, never `docuridge_app:latest`) and confirm the file is in the image: `docker run --rm --entrypoint ls docuridge_e2e_app:latest /app/pdf-worker.cjs`. Then confirm `/readyz` returns 200 on the e2e stack.
- [ ] **Step 6: Commit** `feat(pdf): disposable, capped child process for PDF jobs`.

### Task 4: Upload inspection runs in the worker

**Files:**
- Create: `src/lib/pdf/inspect-upload.ts` (the parse block of `saveUploadedPdf`, moved verbatim in behaviour)
- Modify: `src/lib/pdf-worker/jobs.ts`, `src/lib/pdf-worker/protocol.ts` (the `'inspect'` kind)
- Modify: `src/lib/storage.ts` (`saveUploadedPdf`)
- Test: `src/lib/pdf/inspect-upload.test.ts`, `src/lib/storage.test.ts`

**Interfaces:**
- Consumes: `runPdfJob`, `PdfWorkerError` (Task 3) and the guarded `loadPdfWithDecodeLimits` (Task 1).
- Produces:
  - `inspectUploadedPdf(bytes: Uint8Array): Promise<InspectResult>`, where `InspectResult = { ok: true; pageCount: number; sealCost: PdfSealCost } | { ok: false; code: 'encrypted' | 'unreadable_pdf' | 'pdf_too_complex' | 'unsupported_form'; message: string }`. The messages are exactly today's `UploadValidationError` texts.
  - `PdfJobInput<'inspect'> = { bytes: Uint8Array }` and `PdfJobOutput<'inspect'> = InspectResult`.
  - `saveUploadedPdf` keeps its signature and return type. It runs the inspect job. On `encrypted` it runs `decryptPdf` in the parent, then a second inspect job on the decrypted bytes. `PdfWorkerError` `timeout`/`out_of_memory`/`crashed` map to `pdf_too_complex`, and `busy`/`unavailable` map to a new `UploadValidationError('busy', 'DocuRidge is busy processing other documents. Try again in a minute.')`.

- [ ] **Step 1: Write failing tests.** In `inspect-upload.test.ts`, each existing `storage.test.ts` validation case is run directly against `inspectUploadedPdf`. In `storage.test.ts`:
  - "an encrypted upload is decrypted between two inspections and stored decrypted": mock `runPdfJob` to return `encrypted` then ok; expect `decryptPdf` called once and the stored sha256 equal to that of the decrypted bytes.
  - "a worker timeout is refused as too complex";
  - "a busy worker gives the busy message".
- [ ] **Step 2:** Run `npx vitest run src/lib/pdf/inspect-upload.test.ts src/lib/storage.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `npx vitest run`. Expected: all PASS.
- [ ] **Step 5: Commit** `refactor(upload): inspect uploaded PDFs in the PDF worker`.

### Task 5: Send-time measurement runs in the worker

**Files:**
- Modify: `src/lib/pdf/envelope-seal-check.ts` (`measure`)
- Test: `src/lib/pdf/envelope-seal-check.test.ts`

**Interfaces:**
- Consumes: the `'inspect'` job (Task 4). `measure` reads the bytes in the parent, runs `inspect`, and maps the result:
  - `ok` → `{ ok: true, cost: sealCost }`;
  - `pdf_too_complex` or a `PdfWorkerError` of `timeout`/`out_of_memory` → `too_complex`, with the message as `detail`;
  - everything else → `unreadable`.

  A `busy`/`unavailable` worker is **not cached** and surfaces as `EnvelopeNotSealableError('DocuRidge is busy processing other documents. Try sending again in a minute.')`.

- [ ] **Step 1: Write failing tests:** "a busy worker refuses the send without caching the result" (a second call re-runs the job), and "a worker timeout is cached as too complex".
- [ ] **Step 2:** Run `npx vitest run src/lib/pdf/envelope-seal-check.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(send): measure seal cost in the PDF worker`.

### Task 6: The seal render runs in the worker

Contains find_0161WQy5MypQ1K7sq2nGYzHj until phase 3 replaces the digest.

**Files:**
- Create: `src/lib/pdf/seal-render.ts`. Move from `seal.ts`: the item loop, `stampField`, `drawAuditPage`, `drawCenteredText` and their helpers, plus the body save, digest, attach and final save. It must import nothing from `../prisma`, `../env`, `../crypto/*` or `../audit/*` at runtime (type-only imports are fine).
- Modify: `src/lib/pdf/seal.ts` (`buildSealedEnvelope` becomes the parent orchestrator)
- Modify: `src/lib/pdf-worker/jobs.ts`, `src/lib/pdf-worker/protocol.ts` (the `'seal'` kind)
- Test: `src/lib/pdf/seal-render.test.ts`, `src/lib/pdf/seal-worker.test.ts` (process mode), `src/lib/envelopes/audited-transitions.test.ts`

**Interfaces:**
- Consumes: `runPdfJob` with `onRequest` (Task 3), `embedCachedImage` and `assertSealImagePixels` (Task 2).
- Produces:
  - `SealRenderInput`:

    ```ts
    {
      fieldFont: 'sans' | 'serif' | 'mono';
      items: Array<{ bytes: Uint8Array; fields: SealRenderField[] }>;
      recipients: Array<{ id: string; name: string; email: string;
        signatures: Array<{ imagePngBase64: string | null; typedSignature: string | null; fieldId: string | null }> }>;
      fieldsById: Record<string, { type: string }>;
      auditPage: AuditPageData;
    }
    ```

    `SealRenderField` is today's stamped field shape with `x, y, w, h` as **numbers** (the parent converts Prisma `Decimal`s). `AuditPageData` is exactly the fields `drawAuditPage` reads from `sealedEnv`, with `Date`s kept as `Date`s.
  - `renderSealedEnvelope(input: SealRenderInput, signManifest: (sealedContent: SealedContentDigest) => Promise<Uint8Array>): Promise<Uint8Array>`. The callback returns the signed manifest's JSON bytes; the function returns the final sealed file.
  - `PdfJobInput<'seal'> = SealRenderInput` and `PdfJobOutput<'seal'> = { bytes: Uint8Array }`. In the child, `signManifest` is `askParent({ sealedContent })`. In the parent, `onRequest` builds the manifest with `buildManifest`, signs it with `signHex` exactly as today, and returns its bytes. The signed manifest object is kept for the `SealedBuild`.
  - `buildSealedEnvelope` keeps its signature and `SealedBuild` result. A `PdfWorkerError` propagates, so `completeEnvelope` records it as a build failure.

- [ ] **Step 1: Write failing tests.**
  - `seal-render.test.ts`: `renderSealedEnvelope` on the existing seal fixtures produces a file that `verifySealedPdf` accepts with the fixture key (port the assertions from `seal.test.ts`).
  - `seal-worker.test.ts` (process mode):
    - "a real child seals a two-document envelope and the result verifies";
    - "the child never sees the org key": spy on `signHex` in the parent and expect exactly 1 call; the child's `env` diagnostic was already covered in Task 3;
    - "a seal whose digest exceeds the time limit fails cleanly": a 2000-page fixture whose pages share one 20k-object resource dictionary, with `PDF_JOB_TIMEOUT_SEAL_MS=2000`. It rejects with `PdfWorkerError` `timeout` in under 4 s, and a 10 ms interval in the parent keeps firing.
  - `audited-transitions.test.ts` "a busy PDF worker leaves the envelope retryable": `buildSealedEnvelope` rejects with `new PdfWorkerError('busy')`. `completeRecipientSigning` resolves `{ envelopeStatus: 'IN_PROGRESS', sealFailed: true }`, the signature row exists, and the last audit event is `envelope.seal_failed` with `stage: 'build'`.
- [ ] **Step 2:** Run `npx vitest run src/lib/pdf/seal-render.test.ts src/lib/pdf/seal-worker.test.ts src/lib/envelopes/audited-transitions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `sealFailureData` must name the `PdfWorkerError` reason. Check how it serializes unknown errors and add the reason if it is missing.
- [ ] **Step 4:** Run `npx vitest run`. Expected: all PASS (the existing seal, seal-chain, seal-persist and seal-cost tests run inline).
- [ ] **Step 5: Commit** `refactor(seal): render sealed PDFs in the PDF worker; keys stay in the parent`.

### Task 7: Phase acceptance

**Files:** none in the repo. Scratch scripts go in the session scratchpad. Production data is read in place, read-only. Rendered output goes in a `chmod 700` scratch directory that is deleted afterwards.

- [ ] **Step 1: Corpus check.**
  - Run `inspectUploadedPdf` through `runPdfJob` in process mode over every file in the production uploads directory. Expected: no file that is accepted today is refused, except any the stricter walk refuses. Expected count is 0 (77/77 passed the walk on 2026-10-24).
  - Build seals in inline mode from copies of three production COMPLETED envelopes' inputs, and verify them with `npm run verify` against the org key's public half. Expected: exit 0.
- [ ] **Step 2: Regression map.** Confirm each of the four findings has its test from this plan passing, and list them in the PR description:

  | Finding | Test |
  |---|---|
  | find_014Jf4kxPMfbhPsDbuuNFqkC | `seal-images.test.ts` |
  | find_0161WQy5MypQ1K7sq2nGYzHj (availability) | `seal-worker.test.ts` timeout |
  | find_012oW2gLvKuBSGqip2Sx1Ngj | `page-tree.test.ts` and `decode-limits.test.ts` |
  | find_014hWbSvUmef3cauRsRtCiR5 | `runner.test.ts` fresh-pid test, plus `object-ceiling.test.ts` |

- [ ] **Step 3: Full checks.** Run `npx tsc --noEmit`, `npm run lint` (0 errors), `npx vitest run`, then rebuild the e2e stack with the scratch override and run `npm run test:e2e:isolated`. Expected: all pass, with 97 e2e passing as before.
- [ ] **Step 4: Independent review.** Run the `signing-security-reviewer` and `pdf-render-reviewer` agents on the branch diff, fix what they confirm, and re-run Step 3.
- [ ] **Step 5: Hand to the user** for push, deploy and finding resolution, which follow the established deploy procedure.
