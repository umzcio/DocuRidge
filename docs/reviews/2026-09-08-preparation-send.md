# Preparation and sending workflow review — 2026-09-08

Scope: PDF upload and edits, AI field review, recipient assignment, submit/save,
server validation, invitations, delivery failures, retry, signing, sealed download.

## Confirmed failures and corrections

- Production rejected AI-only preparations with `Envelope has no required fields`.
  AI signatures and initials now default to required; other suggestions remain
  optional. Client and server validate sending before creating an envelope.
- React action resets cleared hidden file inputs after validation failures.
  Every submission now includes the current editor File objects directly.
- Repeated identical errors only triggered one transient toast. Submission errors
  now remain visible in the preparation screen with specific validation messages.
- Lost responses could unmount the editor through the error boundary. They now
  preserve work, expose dashboard access, and require acknowledgment before retry.
  Known partial creations link to the existing envelope and block recreation.
- Aggregate uploads could exceed Next's 50 MiB action limit. Preflight counts PDF
  and metadata bytes with encoding overhead before sending.
- Preparation controls remained editable during an in-flight send. They now lock
  until the request completes, preventing edits that miss the submitted snapshot.
- Server validation incorrectly required fields for approvers and omitted DRAWING.
  Both now agree with supported builder/signing behavior. Off-page fields are
  rejected before storage writes.
- The string `false` enabled reminders through boolean coercion. Parsing now
  preserves the selected setting.
- Failed invitations were marked SENT. Delivery failures now set FAILED, remain
  visible on the envelope, and retry using its existing invitation/reminder flow.
  Parallel retries prioritize failed recipients; reminder failures report errors.
- SMTP defaults could leave Send pending for minutes. DNS, connection, greeting,
  and socket waits now have bounded interactive timeouts.
- The old E2E send URL assertion accepted `/envelopes/new` as a successful result.
  It now requires an actual envelope detail URL. New tests exercise real server
  actions, database writes, MailHog invitations, signing, and PDF downloads.

- A release build assigned CorrectButton webpack module ID zero. Next 15.5.24's
  concatenated-module manifest code treated zero as absent, crashing the sent
  envelope detail page. A guarded prebuild patch preserves zero as a valid ID.
  Send tests now assert the destination title renders, not merely its URL.

## Verification

- 498 unit tests pass; two pre-existing live-provider tests remain skipped.
- 22 desktop/mobile PDF preparation browser checks pass.
- Full-stack regressions cover edited AI preparations, repeated invalid-title
  retries, pending controls, interrupted requests, delivery outage and retry,
  existing signing/token checks, multiple documents, and reminders.
- The supplied parking PDF, rotated upright and using its 37 recorded AI
  suggestions, completed signing and produced a downloadable sealed landscape PDF.
- Typecheck and production build pass. Validation uses isolated database/storage
  and MailHog; no test invitations were sent through the production mail relay.

This review covers the preparation/send workflow, not every application module.

## Release verification

- Final image passed all 11 full-stack regressions, including email outage/retry.
- Build-patch checks: three pass, including numeric module ID zero and idempotence.
- Deployed build: `IBuep5S2jH3rwmk8ebnqU`.
- Production image matches the tested image. Public readiness reports database OK;
  the public builder JavaScript checksum matches the deployed artifact.
- Rollback image retained as `docuridge_app:pre-send-fix-20260908`.
