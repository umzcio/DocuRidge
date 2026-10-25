# DocuRidge — Deployment Notes

This document exists to back the handful of pointers to it scattered across
the codebase (`docker-compose.yml`, `src/lib/mail/allowlist.ts`,
`src/lib/env.ts`, `src/lib/storage.ts`, `SECURITY.md`). It describes only what
the current code does and the seams it leaves for production changes — it is
not a general operations runbook.

## 1. Reverse-proxy placement

The app container has no host port (see `docker-compose.yml`). It is reached
over the `docuridge_proxy_net` Docker network, which the existing `proxy`
container attaches to as an `external: true` network. The upstream `location`
blocks nginx needs are documented as a commented snippet in
`deploy/nginx/docuridge.conf` — copy them into the proxy's `nginx.conf` and
reload nginx; that file also documents the case-canonicalization redirect
DocuRidge needs (`/DocuRidge` vs `/docuridge`) and the trailing-slash gotcha
with Next.js.

## 2. Mail allowlist removal

The allowlist is a code-level gate, not just an env var:

- `isAllowlistEnforced()` (`src/lib/mail/allowlist.ts`) is only `true` when
  `MAIL_BACKEND=smtp_relay`. For any other backend (e.g. `mailhog`), the
  allowlist is not consulted at all.
- When enforced, every outbound address is checked against
  `isAllowedRecipient()`, which reads the comma-separated `MAIL_ALLOWLIST` env
  var. An empty list means nothing sends, even with a valid backend.
- The gate is called from two places: `sendMail()` in `src/lib/mail/index.ts`
  (the actual send path), and `mayMailRecipient()` at four call sites that
  pre-check before doing other work — `src/app/form/[token]/actions.ts`,
  `src/app/dashboard/bulk-send/actions.ts`, `src/app/sign/[token]/actions.ts`,
  and `src/app/dashboard/envelopes/[id]/actions.ts`.

To remove the allowlist for full production, both of these must change in the
**same commit**:

1. The env change (e.g. no longer setting `MAIL_ALLOWLIST`, or however the
   deploy chooses to represent "unrestricted").
2. The gate call sites themselves — `isAllowlistEnforced()` /
   `isAllowedRecipient()` / `mayMailRecipient()` calls listed above.

Changing only the env side (for example, setting `MAIL_ALLOWLIST` to something
that matches everything) is explicitly not the intended removal path — the
code gate is the safety net that a misconfigured env var alone cannot disable,
so removing the net has to be a deliberate code change reviewed like any other
security-relevant diff.

## 3. Virus scanning

`scanFile(buffer)` in `src/lib/storage.ts` is a no-op: it returns `'CLEAN'`
unconditionally for every upload. It is called from
`src/lib/envelopes/service.ts` at upload time, and its result flows into the
`ScanStatus` enum and the `DocumentFile.scanStatus` / `scannedAt` columns in
`prisma/schema.prisma`, which already exist to record a real result.

To swap in a real scanner (e.g. ClamAV), replace the body of `scanFile` with a
call to the scanner (over a socket, HTTP, or a CLI invocation) and map its
result to `'CLEAN' | 'INFECTED' | 'ERROR'`. No other code needs to change —
the enum, the column, and the call site are already wired for a real answer.

## 4. SSO / SAML / OIDC

Per-org OIDC SSO ships (`src/lib/auth/oidc.ts`, `/api/auth/sso/login` and
`/api/auth/sso/callback`); SAML, CAS and an `AUTH_STRATEGY=sso_only` switch do
not, so email/password sign-in stays available alongside it.

SSO is off until the operator binds an issuer to an org in
`SSO_TRUSTED_ISSUERS`, as comma-separated `<org-slug>=<issuer-url>` entries
(see `.env.example`). To wire an org:

1. Register a confidential client at the IdP with redirect URI
   `${PUBLIC_URL}/api/auth/sso/callback`.
2. Add `<org-slug>=<issuer-url>` to `SSO_TRUSTED_ISSUERS` and restart. A
   malformed entry stops the app from starting.
3. An admin of that org saves the same issuer, the client ID and the secret
   under Admin → SSO and enables it. Any other org that tries to save the
   issuer is refused.

With several bound orgs the login page shows one button per org and the login
route requires `?org=<slug>`.

## 5. Canonical documents (2026-10)

Every uploaded PDF now gets a canonical copy, stored next to the original and
made at upload time. It is the file signers see and the one the seal is built
from. Rows uploaded before this release have no copy; they are canonicalized
on demand at send, sign or seal, and the backfill does them all at once so a
refusal shows up at deploy rather than in front of a signer.

Run it once after deploying, from `/app` (the PDF worker bundle is found
relative to the working directory):

```sh
docker exec -w /app <app-container> node canonical-backfill.cjs --dry-run
docker exec -w /app <app-container> node canonical-backfill.cjs
```

Flags:

- `--dry-run`: canonicalizes in the worker and reports what a real run would
  do. It writes no file and no database row (item page counts included).
- `--retry-refused`: clears stored refusals first, so those files are tried
  again (for example after a canonicalizer fix). A refusal is never shown to
  a signer, so it is retried under a draft, sent or in-progress envelope; a
  row a finished envelope or a template uses is left alone and reported as
  `skipped_in_use`.
- `--recanonicalize`: also redoes rows whose stored canonical version is below
  the current one. Use it only after a deliberate canonicalizer change. It
  never clears a row a template uses (every envelope made from it shares the
  row) or one any non-draft envelope uses (a signer may already have seen the
  old bytes): those are reported as `skipped_in_use`, with the envelopes in
  `inUse`.
- `--verify`: instead of canonicalizing, reads every stored canonical copy
  and checks it against the sha256 its row records. Rows without a copy are
  counted as `unsettled` and not listed. It never changes a row.
- `--repair` (only with `--verify`): canonicalizes the original of each copy
  found `missing` or `mismatch` again and writes the file only when the
  result is byte for byte the copy the row names (canonicalization is
  deterministic); otherwise it reports `repair_mismatch` and writes nothing.
  It never changes a row. With `--dry-run` it reports `would_repair`.

```sh
docker exec -w /app <app-container> node canonical-backfill.cjs --verify
docker exec -w /app <app-container> node canonical-backfill.cjs --verify --repair
```

It processes one document at a time and is safe to run again; a finished row
costs no job.

**Reading the report.** One JSON line per source document, then a summary line
(`"summary": true`) with the counts. It lists ids, envelope statuses and
titles only: never PDF content, a hash of an original or a storage path.

- `status`: `ok` (copy made now), `already` (had one), `refused` (the
  canonicalizer will not accept the file; `key` says why, for example
  `hidden_layers`), `skipped_in_use` (a flag asked to clear the row, but an
  envelope listed in `inUse` forbids it), `busy` (the PDF worker was full;
  run again), `error` (`error` is a fixed category: `worker_crashed`,
  `worker_timeout`, `worker_out_of_memory`, `qpdf_missing`, `unavailable`,
  `unexpected_path` or `internal`; check the app logs).
- `items`: every envelope item that uses the document, with its envelope id,
  the envelope's status and the item title.
- `pageCountFixed`: items of draft, sent or in-progress envelopes (or
  templates) whose stored page count differed from the canonical count; the
  item is updated to the canonical count.
- `pageCountDiffers`: items of finished envelopes whose stored page count
  differs; reported only, never changed.
- `fieldsOutOfRange`: fields placed on a page past the canonical page count.
  Review these envelopes by hand (sending such an envelope is refused).

With `--verify`, `status` is `verified`, `missing`, `mismatch`, `repaired`,
`would_repair`, `repair_mismatch`, `busy` or `error`; `found` says what a
repair started from.

The exit code is non-zero if any row ended `busy` or `error` (with `--verify`,
also any copy still missing, changed or unrepaired), or 2 for an unknown flag
or combination.

**Refused rows.** A refused document in a `DRAFT` envelope is harmless: the
sender sees the reason when they try to send. A refused document in a `SENT`
or `IN_PROGRESS` envelope cannot be sealed: contact the sender, or void the
envelope and send it again with a replacement PDF (flattened, or printed to a
new PDF). Refused documents in finished envelopes need no action.

A worker timeout or out-of-memory is not a refusal: nothing is stored, the
row reports `error` (`worker_timeout` or `worker_out_of_memory`), and the
next run, send, sign or seal tries the document again. Run the backfill again
when the host is quieter; a document that times out every time needs a
larger `PDF_JOB_TIMEOUT_UPLOAD_MS` (the canonicalize job's limit) or a
replacement.
