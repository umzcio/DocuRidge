# DocuRidge — Progress Log

## Run Metadata

- **Start time:** 2026-05-05 (Phase 0 begins now)
- **Owner:** DocuRidge Admin
- **Mode:** Autonomous, auto-accept edits, bash requires approval
- **Quality bar:** ~90% to production deployment; quality > timeline

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 0 | Research & Architecture | Complete |
| 1 | Foundations | Pending |
| 2 | Core Envelope Flow | Pending |
| 3 | Multi-Recipient, Lifecycle, Templates | Pending |
| 4 | Cryptographic Hardening | Pending |
| 5 | UX Polish via Playwright Self-Critique | Pending |
| 6 | Bulk Send (conditional) | Pending |
| 7 | Handoff | Pending |

## Phase Entries

(Each phase appends a section here on exit: shipped, deferred with reasons, decisions, time elapsed, test pass rate.)

### Phase 0 — Research & Architecture (complete)

**Shipped:**
- `RESEARCH.md` — competitive UX synthesis across DocuSign / Adobe Sign / Dropbox Sign / PandaDoc / SignWell, plus prior-art study of Documenso / DocuSeal / OpenSign. 19 prioritized design decisions, all sourced.
- `DECISIONS.md` — 31 entries covering stack, reverse-proxy integration deviation (host pattern over amendment's literal `external: true`), subpath `/DocuRidge` baked in from Phase 1, mail allowlist with code-level enforcement, centralized `can()`, PAdES as best-effort, virus-scan extension point, bootstrap admin via one-time token (not log-printed link), unified Envelope/Template, EnvelopeItem multi-doc, template snapshotting on instantiation, JWS signing tokens with `jti` single-use, two audit streams, hash-chained Ed25519-signed audit log as the v1 differentiator, `onDelete: Restrict` on audit FKs, fractional top-left coordinate system with single conversion point, durable `BackgroundJob` table, append-only audit enforced at DB role level, `@signpdf` toolchain attempt for PAdES, isolated-by-default recipient privacy, built-in email branding.
- `SCHEMA.md` — full data model with 22 tables, indexes, FK behavior, multi-tenancy notes, coordinate-system conventions, soft-delete strategy, migration plan, and a coverage table mapping every v1 feature to the tables that support it. All v1 features represented including bulk send and templates.
- `SECURITY.md` — assets, trust boundaries, mitigations across §3 (auth, authz, injection, signing tokens, file uploads, audit-chain tampering, PDF tampering, email allowlist, secrets, logging, rate limiting, headers), explicit deferrals (§4), OWASP Top 10 mapping (§5), bug-class callouts (§6), production prerequisites for handoff (§7), and verification plan (§8). THREAT_MODEL is §4–§7.

**Decisions made (key):** see `DECISIONS.md` D-001–D-031. Most consequential:
- D-002: deviate from amendment's literal `external: true` wording; follow the host's per-app-network convention (compose declares `docuridge_proxy_net`, owner attaches `proxy` to it). Same end state, follows existing pattern, cleaner ownership.
- D-024: cryptographic audit chain (hash + Ed25519 signature) — none of the OSS priors do this; it's UM's regulated-context requirement and the v1 differentiator.
- D-008: bootstrap admin via one-time `BOOTSTRAP_TOKEN` env, not log-printed reset link. Per owner's override of my initial plan.
- D-019: unified `Envelope` table with `type = DOCUMENT | TEMPLATE` discriminator (Documenso pattern).

**Deferred:** none for Phase 0 — research scope capped at ~25 minutes of agent time per stream and met.

**Verified consistent across docs:** signing-token mechanism (HS256 JWS with `jti`), audit-chain mechanism (Ed25519 over event hash with `prev_hash`), DB-role-enforced append-only audit, `onDelete: Restrict` audit FKs.

**Time:** ~30 min wall clock, of which ~16 min was concurrent agent research time (overlapped with document drafting).

**Infrastructure facts captured for Phase 1:**
- Reverse proxy container is named `proxy` (image `nginx:alpine`); it joins one network per app it routes to.
- Default DocuRidge ports (3737, 54317, 8737, 10737) all free on host.
- Host has Node 22.22.2 and Docker 29.4.2 with `docker compose v5.1.3`.
- Existing nginx config uses `set $upstream <name>:<port>; resolver 127.0.0.11; proxy_pass http://$upstream;` pattern with `client_max_body_size 500M` global cap and WebSocket upgrade headers in use. The DocuRidge snippet will mirror this style.
