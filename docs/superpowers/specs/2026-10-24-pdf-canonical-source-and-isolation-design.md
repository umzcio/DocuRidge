# PDF canonical source and isolated PDF processing

Date: 2026-10-24. Status: design, approved direction ("yes go"); details below are Claude's calls unless marked otherwise.

## Why

Three security scans in two days found 14, then 13, then 16 problems, most of them in PDF handling. Each round of patches added PDF-handling code and the next scan found edge cases in it. Two root causes sit under almost all of them:

1. **Two parsers read the same untrusted bytes.** Signers see the raw upload through pdf.js. The seal is rebuilt from the same bytes by pdf-lib, and the verifier reads seals with pdf-lib. Wherever the two parsers disagree (duplicate objects, page-tree `/Count`, form `/V` vs `/AP`, name escapes, stream framing, xref recovery), what the signer saw, what was sealed and what the verifier vouches for can differ.
2. **pdf-lib runs on untrusted input inside the web server**, on the event loop, with no time or memory bound. Its global intern pools never shrink, its page-tree walk can go exponential, and the digest re-walks shared resources once per page.

This design removes both causes instead of patching each symptom:

- every uploaded PDF is rewritten **once**, into a canonical file that is exactly "the seal minus the stamps". Signers are shown that file and the seal starts from it.
- new seals must be byte-for-byte what the sealer's writer produces, so the verifier accepts exactly one layout;
- all server-side PDF parsing runs in a disposable child process with hard memory and time limits.

It closes the 13 open PDF findings (table at the end).

## What real uploads look like (measured 2026-10-24, production)

| Measurement | Result |
|---|---|
| Uploaded PDFs | 77, at most 8 pages and 0.5 MB each |
| Already written by pdf-lib | 68 (the in-browser editor re-saves before upload) |
| Annotations | only Link (48) and form Widget (12) |
| Optional content (layers) | 1 file |
| Embedded files | 2 files |
| Existing digital signatures | 2 files (Acrobat Sign) |
| Encrypted | 1 file |
| Rewritten by pdf-lib (`load` + `save({useObjectStreams:false})`) | 77 of 77 render identically to the original (poppler, 30 dpi, grey) |
| pdf-lib output re-read and re-saved | 76 of 76 parseable outputs are byte-identical: `save∘load` is a fixed point on pdf-lib's own output |
| Existing sealed PDFs | 41, all written with object streams, so none is a fixed point of today's writer |

So canonicalization changes nothing visible for real uploads, and byte-identity is achievable for new seals but not retroactively for the 41 existing ones.

## Goals

- The signer is shown, pixel for pixel, the page content that gets sealed: the same bytes, minus the stamps added at completion.
- The verifier accepts a new seal only if it has a single possible reading.
- No PDF a user uploads can stall, crash, or permanently grow the memory of the web server.
- Each of the 13 findings is closed by its own fix criteria, with its own test as a regression test.

## Non-goals

- Keeping links, comments, layers, form interactivity or attachments in signed documents. The seal already drops all of these. This design makes the signer's view drop them too, so the two agree.
- PDF/A output, a different PDF library, or a change to how manifests are signed.
- Retroactively re-sealing existing documents.

## Anti-goals (a failure even if everything technically works)

- Any visible change to an ordinary upload.
- The 41 existing seals no longer verifying.
- Private keys, DB credentials or signing secrets reachable from the PDF process.
- A new service, container or exposed port.

## Design

### 1. Isolated PDF worker

- **One job, one process.** A job runner in `src/lib/pdf-worker/` forks a fresh Node child (`child_process.fork`) for every job. The child exits when the job ends. This resets pdf-lib's global `PDFName`/`PDFRef` intern pools after every parse, which `worker_threads` or a reused pool would not.
- **Hard limits per job.**
  - Memory: `--max-old-space-size` from `PDF_WORKER_HEAP_MB` (default 512).
  - Time: a wall-clock limit by job type: upload 30 s, seal 60 s, verify 60 s. On expiry the child gets `SIGKILL`.
  - A child that dies of out-of-memory, timeout or a crash is reported as a typed failure. That gives a clear upload error, or `envelope.seal_failed`. It never takes the server down.
- **Bounded concurrency.** `PDF_WORKER_CONCURRENCY` defaults to 2, with a queue that waits at most 30 s. A full queue answers "busy, try again" instead of piling up processes.
- **Nothing secret goes in.** The child is spawned with a minimal environment: no `DATABASE_URL`, JWS secrets or key material. It does no DB or filesystem I/O. The parent reads files and sends bytes over IPC (`serialization: 'advanced'`), and writes whatever bytes come back. Manifest signing stays in the parent: the worker asks the parent over IPC to sign a manifest hash, or the job is split in two (builder's choice).
- **Everything that parses an untrusted PDF on the server goes through it:**
  - upload canonicalization;
  - the seal build, including the content digest;
  - the send-time check, which becomes a database lookup (see §2);
  - in-app verification, if any.

  qpdf decryption is already a child process with a timeout, and can stay in the parent ahead of the job.
- **Ceilings before parsing.** Before pdf-lib parses anything, a cheap byte scan refuses a file whose count of `obj` definitions exceeds `PDF_MAX_OBJECTS` (the existing 1M seal-object cap). The heap cap backs this up.
- **Build.** Next's standalone output does not trace a forked entry point, so the worker entry is bundled separately (esbuild, which tsx already brings) and copied into the runtime image. Tests run the same entry through tsx.
- **Backstop.** Add a `mem_limit` for the `app` service in `docker-compose.yml`. This is not an exposure change, but it does mean updating the infra inventory if the inventory tracks resource limits.
- **The verify CLI** is already its own process. It gets the same pre-parse ceiling and the strict page-tree walk.

### 2. Canonical source document

At upload, after decryption, the worker runs these steps in order. A refusal is a clear upload error that names the problem and tells the sender what to export instead.

1. **Strict page-tree walk before any `getPages()`.** Use a visited set, require every node and kid to be indirect, typed `/Pages` or `/Page`, and reached once. Enforce the page cap during the walk. This is the existing `pageTreeLeaves` logic, moved ahead of pdf-lib's own walk. Closes the exponential blow-up and the `/Count` and untyped-kid differentials.
2. **Refuse what the seal can't reproduce faithfully:**
   - XFA forms;
   - `/NeedAppearances true`, since pdf.js would repaint from `/V` but the seal bakes `/AP`. The message is "export a flattened PDF". None of the 77 real uploads has it;
   - widgets with no appearance, or with NoRotate or `/OC` (as today);
   - a non-widget annotation with a visible normal appearance, i.e. not Hidden or NoView and with a non-empty `/AP /N`. This matches what the in-browser editor already refuses. Links and popups with no appearance are dropped silently; their only effect is clickability;
   - optional content where any group is OFF in the default configuration (`/D /OFF`, `/BaseState /OFF`, usage or OCMD rules). If every group is ON, `/OCProperties` is dropped, which causes no visible change. The one real upload with layers is a Word export with every group ON.
3. **Build "the seal minus the stamps"** with the seal's own page pipeline:
   - widget appearances flattened in;
   - each page drawn upright on a fresh page, with UserUnit, CropBox and Rotate baked in;
   - no annotations and no catalog extras (outlines, names, attachments, structure tree, metadata);
   - a fixed Info dictionary (Producer `DocuRidge`, no dates), so identical input gives identical bytes.

   Existing digital signatures in an upload are flattened to their appearance, exactly as the seal already does.
4. **Write and self-check.** Write with `save({ useObjectStreams: false })`. Then require that re-reading and re-saving gives identical bytes, and that the result passes the strict structure check (`pdf-structure.ts`). Failing either is a bug, and the upload is refused, not stored.
5. **Return results:** the canonical bytes, the page count, per-page sizes, and the seal cost. The send-time check then reads these from the database instead of re-parsing.

**Storage.**
- `DocumentFile` gains `canonicalStoragePath`, `canonicalSha256`, `canonicalVersion` (int, starting at 1) and `canonicalPageCount`. This is an additive migration.
- The original stays where it is, content-addressed. It is provenance only, never shown to signers and never sealed.
- The canonical file is content-addressed under `<orgId>/canonical/<sha256>.pdf`.
- `EnvelopeItem.pageCount` comes from the canonical page count. The client-supplied count is ignored.

**Served.**
- The signing route always serves the canonical file. So does the dashboard preview; the sender keeps `?original=1` for the original.
- The API v1 document download serves the canonical file by default, with `?original=1` for the original (builder's choice).

**Sealed.**
- The seal reads the canonical file and checks its sha256 against the row.
- It copies its already-upright, already-clean pages (`copyPages`, with no second flatten or re-embed), stamps the fields and appends the audit page.
- The manifest keeps `sourceSha256` (the original) and adds `canonicalSha256` per document.

**Existing data.**
- A deploy-time backfill script canonicalizes every `DocumentFile` (84 rows), through the worker, and reports any that are refused.
- Sending and sealing canonicalize on demand if a row has no canonical file yet.
- A template whose file is refused is flagged on the template page with the reason, and its sender re-uploads.
- In-flight envelopes switch to the canonical file. The corpus measurement says this is visually identical.

### 3. Seal format v4 and verifier

- **Fixed-point seals.** Seals are already written without object streams. New: after attaching the manifest, the sealer asserts that the final file is a fixed point of `save(load(file))` (loaded with `updateMetadata: false`). If it is not, the seal fails safely as `envelope.seal_failed`.
- **Manifest version 4, digest version 4: linear-time object-table digest.**
  - Because a v4 file has exactly one byte layout, the digest no longer needs a graph walk. It hashes pdf-lib's serialization of every indirect object once, in object-number order. From this it excludes:
    - the objects the manifest attachment added;
    - from the catalog: its `/Names /EmbeddedFiles` and `/AF` entries.
  - Every byte that can affect rendering is covered, and cost is linear in file size.
  - The manifest records what the verifier needs to separate the attachment's objects, for example the pre-attachment object count.
- **v4 verification**, all in the capped context:
  - the pre-parse ceiling;
  - parse, then the byte-for-byte fixed-point check;
  - every indirect object reachable from `/Root`, `/Info` or the trailer;
  - the existing structure, attachment, signature and chain checks;
  - the linear digest.
- **Legacy seals (manifest v1–v3, including all 41 in production)** keep today's verification path plus targeted checks:
  - refuse any name containing a `#` escape that is not two uppercase hex digits, and any dictionary with two keys that decode to the same name;
  - stream framing: `stream` followed by exactly CRLF or LF, a direct integer `/Length`, exactly that many bytes, then `endstream` and `endobj`;
  - object-stream slots: offsets strictly increasing, each parsed extent ending before the next slot, and `/N` matching the pairs read;
  - reachability.

  All 41 production seals must still verify (checked before deploy). `--strict` requires v4.

### 4. Remaining resource findings

- **Signature and stamp images:** each distinct image is decoded and embedded once per sealed document, cached by the sha256 of its bytes.
- **Field caps:** a per-envelope and per-page field cap (defaults 2000 and 200, from env), enforced:
  - in the action schemas and in `addField`;
  - at send;
  - in template instantiation, API v1, public forms and bulk send.
- **Image pixel budget:** an envelope-wide budget for decoded image pixels, checked before the seal starts.

## Finding → fix

| Finding | Severity | Closed by |
|---|---|---|
| find_014Jf4kxPMfbhPsDbuuNFqkC: image field decode per field | high | §4: images deduplicated, field caps, pixel budget. The worker contains what remains. |
| find_0161WQy5MypQ1K7sq2nGYzHj: digest re-walks shared resources per page | high | §3: linear v4 digest. The worker bounds legacy verification. |
| find_012oW2gLvKuBSGqip2Sx1Ngj: exponential `getPages()` | high | §2 step 1: strict walk first. Also §1. |
| find_014hWbSvUmef3cauRsRtCiR5: pdf-lib intern pools grow | high | §1: one process per job, plus the pre-parse ceiling |
| find_019pUbrXFsNQhGPYgxUwMpKb: `/Count` and untyped kids differ | medium | §2 steps 1 and 3: the signer sees the canonical file |
| find_01MPXLxm41G5RC1ojiExrcg4: duplicate objects | medium | §2: the canonical file has one definition per object |
| find_01AkiSV6J1yfpekbW3uirhmz: lowercase `#xx` name escapes | medium | §3: v4 fixed point. Name check on legacy seals. |
| find_01Ttx83q18EAwER8rJqyh1sv: bare `stream` keyword | medium | §3: v4 fixed point. Stream framing check on legacy seals. |
| find_01Njst3YEnfXyEWvF3UA2ta6: xref tables pdf.js rejects | medium | §3: v4 fixed point plus reachability. Reachability on legacy seals. |
| find_016H3wUkTnARCoD3T3mghHw6: `/NeedAppearances` vs `/AP` | medium | §2 step 2: refused |
| find_01FS1qr8YPoZGndLMnzv6uu5: seal drops annotations | medium | §2 steps 2 and 3: refused or dropped before the signer sees them |
| find_01SNv2YpN7XQmYGvuQhLBJCs: seal drops optional content | medium | §2 step 2: OFF layers refused; all-ON layers dropped without visible change |
| find_016fTmmWXXWK2dHwKZzS81DJ: object-stream slot extents | low | §3: v4 seals have no object streams. Slot check on legacy seals. |

## Rollout

Three phases. Each is independently shippable and goes through: parallel build, independent review (signing-security-reviewer and pdf-render-reviewer), the full unit and e2e suites, then push, deploy and mark findings.

1. **Isolation and caps** (§1, §2 step 1 at upload, §4). Closes the four high findings. No format changes.
2. **Canonical source** (§2): migration, backfill, serving, and seal-from-canonical. Closes the five view-vs-seal findings.
3. **Seal v4 and verifier** (§3). Closes the four verifier findings and the digest half of the shared-resource finding.

**Checks every phase must pass:**
- each finding's own test is a regression test;
- the production corpus check (in a throwaway scratch directory, deleted afterwards): every upload canonicalizes with zero raster difference, and all 41 seals verify;
- a test that the worker gets no secrets in its environment.

## Calls Claude made (the user delegated the design)

- Refuse rather than bake visible non-widget annotations and OFF layers. This matches the existing editor, and there are zero such files in the corpus.
- Child process per job, not worker threads or a reused pool, because a reused pool keeps the intern pools growing.
- Keep the original upload for provenance only. Signers and seals use only the canonical file.
- Use the linear object-table digest for v4 instead of memoizing the v3 graph walk. This is possible only because of the fixed-point rule, and it is simpler.
- Legacy seals keep their current verification plus targeted checks, and `--strict` requires v4.
- The defaults above (heap 512 MB, concurrency 2, field caps 2000/200, time limits). All of them are env-configurable.

## Left to the builder

- The IPC protocol and whether signing is an in-job RPC or a two-step job.
- The bundling details for the worker entry.
- The exact refusal messages.
- Whether the API download defaults to canonical.
- The `mem_limit` value.
- How the v4 manifest marks the attachment's objects.
