# DocuRidge → UMT DocuSign Replacement — Roadmap

**Date:** 2026-08-31
**Owner:** CIO (UMT)
**Primary users:** HR and Business Services — contracts
**North star:** UMT cancels the DocuSign renewal (~$200k/yr avoided) after
HR and Business Services migrate their contract volume, with Legal and IT
Security sign-off.

## Ground rules

- The bar is **switch-readiness**, not feature parity. A feature is on this
  roadmap only if its absence would block or stall the migration. Everything
  else is a differentiator or a non-goal.
- Roadmap items are keyed to the stakeholder who vetoes without them.
- Team reality: one engineer + AI agents. Phases are ordered so each one
  leaves the product usable and the migration closer, not by feature count.

## Identity model (decided)

Dual-mode login, like DocuSign:

- **Company:** staff sign in via Entra (OIDC first; SAML later if a second
  IdP demands it). IdP configuration lives per-org in admin settings
  (issuer, client ID/secret, scopes) — not hardcoded. `src/lib/auth/` is the
  strategy seam (SECURITY.md §7 calls this out by design).
- **Personal:** external signers and non-SSO staff keep email/password
  accounts. Recipients signing via token link need **no account at all** —
  this already works and is a migration selling point for external counsel,
  vendors, and candidates.

## Already covered (verified in codebase)

Sequential/parallel routing with approver/CC/witness/in-person roles, 20
field types incl. formulas and attachments, decline/reassign, comments,
templates + bulk instantiation, public forms (≈ PowerForms), automatic
reminders, webhooks, share links with expiry, ed25519 tamper-evident audit
chain with independently verifiable sealed PDFs, mobile-responsive signing
ceremony, rate limiting + lockout, RBAC-lite (org roles).

---

## Phase 1 — Contracts switch gate (Legal + HR/Business Services sign-off)

The veto points. Nothing else matters until these land.

1. **Configurable SSO (Entra via OIDC).** ✅ *Built 2026-08-31 — dormant by
   design.* Strategy-pattern auth; per-org IdP settings UI; JIT provisioning
   of SSO users into org roles; personal accounts untouched. **Testing and
   Entra integration are explicitly last priority** — nothing in the pilot
   or cutover path depends on it; basic auth covers all milestones below.
   Lights up only when an org enables it in settings. *Veto: IT Security —
   deferred to whenever the Entra app registration exists.*
2. **Per-recipient access codes.** Sender sets a 4–12 char code per
   recipient; signer must enter it before the ceremony opens. Token-gated
   links + access code = the contracts-grade identity story for external
   parties. *Veto: General Counsel.*
3. **Envelope correction.** Modify recipients (add/replace/reorder before
   their turn), message, and expiration on a sent, unsigned envelope;
   recorded as an `envelope.corrected` audit event. Contract routing typos
   are the #1 day-2 support pain in signing tools. *Veto: HR directors.*
4. **Completion package.** One-click per-envelope export: human-readable
   certificate PDF + audit JSON, both carrying the existing signed audit
   chain. Counsel gets a records-ready artifact. *Veto: General Counsel,
   Records.*
5. **Contract pipeline reporting.** In-progress/aging/outstanding views
   filterable by department and sender, with CSV export. Business Services
   runs on "what's pending and with whom." *Veto: Business Services.*

**Exit:** one HR unit runs real contracts through DocuRidge for 30 days
without a workaround.

## Phase 2 — Integration and departmental scale

6. **REST API v1 + scoped API keys.** Envelopes: create/list/status,
   documents download, webhook subscribe. Auth: org-scoped API keys with
   read/write scopes. Targets: HRIS/procurement systems contracts originate
   in. Webhooks already exist — this is the payoff feature.
7. **Business units as Brands + Teams.** Flat org (no sub-tenants — see
   non-goals). Two constructs, matching how DocuSign departments actually
   work:
   - **Brands** (like DocuSign Brands): multiple branding profiles — logo,
     colors, email template, footer, sender identity. Sender picks the HR or
     Business Services brand per envelope, or sets a template default;
     outbound emails and the signing ceremony render that brand. Schema:
     `Brand` model, `envelope.brandId` (fallback: org default), template
     default brand. The existing branding settings page becomes the brand
     editor.
   - **Teams**: many-to-many user groups. Template folders get
     team-scoped visibility (HR templates aren't clutter for Business
     Services and vice versa); pipeline reports filter by team/sender.
   Envelopes stay org-owned — no cross-unit ownership questions.
8. **Delegation rules.** Out-of-office delegation (auto or manual) so a
   contract doesn't stall for a week when a signer is away. Builds on the
   existing reassign machinery.
9. **CSV recipient lists for bulk policy acknowledgments.** Small but cheap:
   HR's other signature use (policy attestations) is one CSV away.

**Exit:** HR and Business Services both run production volume; at least one
system integration (even a scripted one) consumes the API.

## Phase 3 — Cutover and institutional hardening

10. **DocuSign migration kit.** (a) Template import from DocuSign exports so
    departments don't rebuild hundreds of contract templates by hand;
    (b) in-flight envelope drain procedure; (c) archive export for closed
    DocuSign envelopes (PDF + metadata) so records obligations survive the
    cancellation.
11. **UMT contract template library + retention.** Standard contract types
    pre-built; retention policies and legal hold aligned to the university
    records schedule.
12. **Production readiness.** HA/backup/DR runbook, restore drill, load pass
    at contract-peak volume, security review (the `plans/` advisor backlog
    feeds directly into this), accessibility audit (axe suite already runs
    in e2e).
13. **Later/optional:** Entra group sync for role provisioning; SAML IdP for
    a second provider; e-notary partner integration if a specific contract
    type ever demands it.

**Exit:** renewal cancelled; DocuSign retained only as a read-only archive.

## Non-goals (deliberate)

Payments, remote online notarization (partner, don't build), commercial
IDV/KBA (SSO + access codes satisfy university identity assurance), native
mobile apps (responsive web suffices), template marketplace,
multi-tenant SaaS (this deployment is UMT's), and **sub-tenant hierarchies**
— business units are expressed as Brands + Teams (Phase 2), not partitioned
tenants. Legally separate entities that genuinely need isolation (e.g. a
foundation vs. the university) get their own org/deployment, which the
schema already supports via `orgId`.

## Differentiators to put in front of the provost

- ~$200k/yr avoided, no per-seat pricing → every department can adopt.
- Contract data never leaves campus infrastructure (FERPA/worker-data posture).
- Every sealed PDF re-verifies offline, forever, with `npm run verify` —
  DocuSign's completion certificate is a PDF nobody can independently check.
- External parties sign with no account, no app, no vendor relationship.

## Scoreboard

| Milestone | Measure |
| --- | --- |
| Phase 1 exit | 1 HR unit, 30 days, zero workarounds |
| Phase 2 exit | HR + Business Services production volume; 1 API consumer |
| Phase 3 exit | Renewal cancelled; archive exported; restore drill passed |
| Final | $200k/yr avoided, DocuSign decommissioned |
