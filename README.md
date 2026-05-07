# DocuRidge

Self-hosted, production-grade DocuSign / Adobe Sign replacement. Drop it on your own infrastructure, configure your SMTP relay and SSO, and you have a real e-signature platform with a verifiable audit chain.

## What v1 ships

- Self-hosted Postgres + Next.js 15 stack, fully containerised, deployed at `/DocuRidge` behind a reverse proxy of your choice (nginx, Caddy, Traefik).
- Email + password auth (Argon2id) with email verification, password reset, account lockout, server-side sessions. Auth is designed as a strategy swap so SSO (SAML / OIDC / CAS / Shibboleth) is plug-in work, not a rewrite.
- Org-scoped multi-tenancy with role-based access (`ADMIN`, `SENDER`, `VIEWER`) and a centralized `can(user, action, resource)` permission function.
- Mail abstraction with two backends (`mailhog` for dev, `smtp_relay` for production), gated by an in-code recipient allowlist with its own unit tests.
- PDF upload with size + MIME validation, in-browser preview, drag-and-drop field placement (signature, initials, date, text, number, checkbox, radio, dropdown, formula, attachment, name, email, drawing, and more), sequential and parallel multi-recipient routing, single-use signed signing tokens, UETA/ESIGN-aware consent, and final-confirm signing ceremony.
- Cryptographic audit chain — every state-changing event is hashed and Ed25519-signed, chained by `prev_hash`, and verifiable with `npm run verify <sealed.pdf>`.
- Sealed PDF output: signatures stamped, audit page appended, signed JSON manifest embedded as a PDF attachment.
- Templates (envelope shape + role placeholders) with snapshotting on instantiation, plus bulk send via CSV → one envelope per row.
- Multi-font typed signatures, per-org default field font, conditional routing & visibility, comments, finish-later drafts, webhooks, PowerForms public links.

## Quickstart

```bash
# 1. Clone and prepare env
cp .env.example .env

# 2. Bring up the stack (project name MUST be docuridge)
docker compose -p docuridge up --build -d

# 3. Watch logs until the entrypoint reports "starting app"
docker compose -p docuridge logs -f app

# 4. The entrypoint generated a BOOTSTRAP_TOKEN into .env. Read it:
grep '^BOOTSTRAP_TOKEN=' .env

# 5. Visit the app. With your reverse proxy installed:
#    https://your-domain.example.com/DocuRidge/setup
#    Enter the bootstrap token, choose an admin password, sign in.
```

### Local development without a reverse proxy

The app container does not bind a host port in the production compose file (`docker-compose.yml`). For local iteration and Playwright tests, layer in `docker-compose.local.yml`:

```bash
docker compose -p docuridge -f docker-compose.yml -f docker-compose.local.yml up --build -d
# now reachable at http://127.0.0.1:3737/DocuRidge
```

This binds the app to `127.0.0.1:3737` (loopback only — never `0.0.0.0`). The override file is **not** auto-loaded; production deployments invoke `docker compose -p docuridge up --build` (no `-f`) and stay isolated to the docker network.

## Tests

Vitest unit tests:
```bash
npm install
npm run test
```

Playwright end-to-end (requires the stack to be running):
```bash
npm run test:e2e
```

## Verifying a sealed PDF

```bash
docker compose -p docuridge exec app npm run verify -- /path/to/sealed.pdf
```

Re-walks the audit chain, verifies Ed25519 signatures, recomputes the document hash, exits non-zero on any tamper.

## Reverse-proxy integration

The app listens internally on `docuridge_app:3000` over a Docker network. Attach your existing reverse-proxy container to that network and drop `deploy/nginx/docuridge.conf` (or the equivalent for your proxy of choice) into its config. See `DEPLOYMENT.md`.

## Architecture

- **Frontend**: Next.js 15 App Router, TypeScript strict, Tailwind, server components + server actions for mutations.
- **Database**: Postgres 16 via Prisma (versioned migrations, no `prisma db push`).
- **PDF**: pdf-lib for stamping; react-pdf for in-browser preview.
- **Crypto**: Argon2id for passwords, JWS for signing tokens (`jose`), Ed25519 for the audit chain.
- **Mail**: `nodemailer` with two transports; allowlist enforced in code.
- **Logging**: `pino` JSON; per-request ID; user/action/resource fields.
- **Tests**: Vitest unit + integration; Playwright e2e + smoke.

## Documents in this repo

- `PROGRESS.md` — the running phase log; check this for current status.
- `DECISIONS.md` — every architectural decision with rationale.
- `RESEARCH.md` — competitive UX synthesis + OSS prior-art notes that drove the design.
- `SCHEMA.md` — full data model, indexes, FK behavior, multi-tenancy notes.
- `SECURITY.md` — threat model + mitigations + production prerequisites.
- `DEPLOYMENT.md` — operator runbook for installing into production.
- `OPERATIONS.md` — backup, restore, key rotation, common incident playbooks.

## Project conventions

- Container/network/volume names are all `docuridge_`-prefixed.
- All ports are configurable via `.env`. Defaults: postgres `54317`, mailhog UI `8737`, mailhog SMTP `10737`. The app has no host port.
- Postgres and MailHog bind only to `127.0.0.1` for safety.
- Schema changes are versioned migrations; `db push` is forbidden in committed code.
- Audit logs use `onDelete: Restrict` — they outlive their envelopes.
- Centralized `can()` is the only authorization surface; no inline role checks.
- Path matches case-sensitively at `/DocuRidge`. `next.config.js` sets `basePath` and `assetPrefix`.

## License

TBD — see the repository for the chosen license.
