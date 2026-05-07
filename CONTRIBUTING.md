# Contributing to DocuRidge

DocuRidge is licensed under [GPL-3.0](LICENSE). Contributions are welcome — bug reports, fixes, features, documentation, and tests all help. This file describes how to work with the codebase.

## Ground rules

- **Authorisation everywhere.** No endpoint trusts the client to tell it who the user is or what they're allowed to do. Every server action and route handler passes through `can(user, action, resource)` in `src/lib/auth/can.ts`.
- **Validate at the boundary.** Every request is parsed with Zod before it touches business logic. Reject early. Never trust a client-supplied ID without an ownership check.
- **No `prisma db push` in committed code.** Schema changes are versioned migrations. The container entrypoint runs `prisma migrate deploy` on startup.
- **No secrets in code or logs.** All secrets come from env vars. The org Ed25519 key is generated on first boot, persisted to a dedicated volume, never logged, never returned by any endpoint.
- **Tests beyond the happy path.** Each feature ships with: a Playwright test for the user flow, unit tests for the business logic + authorisation, and at least one negative test (unauthorised access, malformed input, expired token).
- **Default to writing no comments.** Only add one when the WHY is non-obvious — a hidden constraint, a subtle invariant, a workaround for a specific bug. Don't comment on what well-named code already says.

## Local development

```bash
git clone https://github.com/umzcio/DocuRidge.git
cd DocuRidge
cp .env.example .env

# Start the stack (project name MUST be docuridge — every container,
# network, and volume is scoped to that prefix)
docker compose -p docuridge up --build -d

# Local-dev override: binds the app to 127.0.0.1:3737 so you can hit
# it without a reverse proxy
docker compose -p docuridge \
  -f docker-compose.yml \
  -f docker-compose.local.yml \
  up --build -d

# Read the auto-generated bootstrap token
grep '^BOOTSTRAP_TOKEN=' .env

# Visit http://127.0.0.1:3737/DocuRidge/setup
```

### Running tests

```bash
npm install
npm run typecheck     # strict TS
npm run test          # Vitest unit + integration
npm run test:e2e      # Playwright e2e (requires the stack to be running)
npm run lint
```

### Schema changes

```bash
# Edit prisma/schema.prisma, then create a migration
npx prisma migrate dev --name <descriptive_name>

# The migration file lands in prisma/migrations/<timestamp>_<name>/
# Commit both the schema change and the migration.
```

If a migration includes `ALTER TYPE "Enum" ADD VALUE` (Postgres rejects this inside a transaction) it must live in its own migration file separate from any DDL that creates tables referencing the new value.

## Pull requests

1. **Fork** and create a branch off `main`. Branch name should describe the change (`feat/conditional-routing`, `fix/seal-checkmark-encoding`, `docs/architecture-diagram`).
2. **One logical change per PR.** Don't bundle a refactor with a feature.
3. **Run the test suite locally** before opening the PR.
4. **Update the README / SECURITY.md** if your change touches anything user-facing or affects the threat model.
5. **Conventional-commit messages**: `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`. Subject under 70 characters; body explains the *why*.
6. **PR description** should answer: what does this change do, why is it needed, what's the test coverage, and what risks should reviewers think about?

## Reporting bugs

Open a [GitHub issue](https://github.com/umzcio/DocuRidge/issues) with:

- DocuRidge version (`git rev-parse --short HEAD` if running from source)
- Browser + OS (for UI bugs)
- Reproduction steps — the exact sequence that triggers the bug
- Expected vs. actual behaviour
- Relevant log lines (`docker compose -p docuridge logs app`)

For UI bugs, a screenshot or screen recording helps a lot.

## Reporting security issues

**Do not open a public issue** for vulnerabilities. Email the maintainer or use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) on this repository. See [SECURITY.md](SECURITY.md) for the threat model and what's in scope.

In-scope examples:
- Authentication bypass, session fixation, IDOR, CSRF
- Audit-chain forgery or tampering that the verify command fails to detect
- Signing-token theft, replay, or recipient impersonation
- Email allowlist bypass when `MAIL_BACKEND=smtp_relay`
- Server-side request forgery, file-upload escapes, SQL injection

Out of scope: rate-limit tuning, missing security headers on `/healthz`, social-engineering hypotheticals.

## Code style

- **TypeScript strict** — no `any`, no `// @ts-ignore`. If a type is genuinely unknown, narrow it with a Zod schema at the boundary.
- **Server Components by default**, Client Components (`'use client'`) only where you actually need state, effects, or browser APIs.
- **Server Actions for mutations**; route handlers only when you need raw HTTP access (file uploads, webhooks).
- **Prisma queries** include `select` or `include` to avoid over-fetching. Never `findMany()` on user-owned data without an org-scoped where clause.
- **Tailwind utility classes** in JSX. Custom CSS only when a utility doesn't exist or for keyframes.
- **Logger** is `childLogger({ module: '...' })` — never `console.log` in committed code.

## Architecture decisions

The README's [Design Decisions](README.md#design-decisions) section explains the major architectural choices and *why*. If you're proposing a change that contradicts one of those decisions, lead the PR description with the rationale — they're not load-bearing forever, but they were made deliberately.

## License of contributions

By submitting a contribution, you agree that it will be licensed under [GPL-3.0](LICENSE), the same license as the rest of the project.
