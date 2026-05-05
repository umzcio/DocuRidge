# DocuRidge — UX & Prior-Art Research

Two parallel research streams informed this document:
1. **Competitive UX research** across DocuSign, Adobe Acrobat Sign, Dropbox Sign, PandaDoc, SignWell — extracting what users complain about and what they praise, with emphasis on the *recipient* experience.
2. **OSS prior-art study** of Documenso, DocuSeal, and OpenSign — schema patterns, signing flow, audit trail, sealing mechanics.

This document collapses both streams into prioritized design decisions for DocuRidge v1. Each decision cites the source insight that drove it.

---

## Cross-cutting themes

1. **Recipients are scared, and recipients are not customers.** Phishing fatigue + look-alike scam emails make legitimate signing emails feel suspect. The recipient's first three seconds (email + landing page) is the most underweighted UX surface across the industry. ([Bitdefender on DocuSign phishing](https://www.bitdefender.com/en-us/blog/hotforsecurity/signing-contracts-with-docusign-watch-out-for-these-phishing-scams), [G2 DocuSign reviews](https://www.g2.com/products/docusign/reviews))

2. **"In progress" is not a status.** Senders across DocuSign, Adobe, SignWell repeatedly complain that they cannot tell who's holding things up. ([G2 DocuSign](https://www.g2.com/products/docusign/reviews), [G2 SignWell pros/cons](https://www.g2.com/products/signwell/reviews?qs=pros-and-cons))

3. **PDFs do not fit phones.** Pinch-zoom signing has up to 35% abandonment. Industry response is responsive HTML for reading + PDF only at sealing. ([eSign Global](https://www.esignglobal.com/blog/mobile-responsive-signing-experience))

4. **Drawn signatures look terrible by default.** Default stroke too thin, canvas too small, mobile touch produces wobble. Result feels "not really my signature." ([DocuSign Community](https://community.docusign.com/esignature-111/signatures-are-too-small-and-faint-5277))

5. **Mid-flight correction is a desert.** Adobe forbids edits post-send; DocuSign requires void+resend; PandaDoc's add-recipient flow is so confusing users start over. ([G2 Adobe](https://www.g2.com/products/adobe-acrobat-sign/reviews?qs=pros-and-cons), [G2 PandaDoc](https://www.g2.com/products/pandadoc/reviews))

6. **The certificate is not the audit trail.** Users (and lawyers) confuse one-page Certificates of Completion with a full event log. Disputes go badly when only the certificate is preserved. ([Adobe explainer](https://www.adobe.com/acrobat/business/hub/esignature-audit-trail.html), [Anvil's audit-trail schema](https://www.useanvil.com/blog/engineering/e-signature-audit-trail-schema-events-json-checklist/))

7. **None of the OSS priors implement audit-chain integrity.** Documenso, DocuSeal, OpenSign all use plain audit-event rows with no hash linking and no per-event signatures. For UM's regulated context this is unacceptable; DocuRidge closes the gap.

8. **The de-facto Node PDF-signing toolchain is `@signpdf`** (`@signpdf/signpdf`, `@signpdf/signer-p12`, `@signpdf/placeholder-pdf-lib`). Documenso, OpenSign, and most others converge on it. ([OpenSign PDF.js](https://github.com/OpenSignLabs/OpenSign/blob/main/apps/OpenSignServer/cloud/parsefunction/pdf/PDF.js))

---

## 18 Prioritized Design Decisions for DocuRidge v1

Each entry: **decision** → *rationale + source*.

### Recipient experience

**R-1. Recipient email must be aggressively un-phishy.** Subject: `[Sender Name] needs your signature: [Document Name]`. No marketing chrome. Sender's actual name + email visible in the body. A `Why am I getting this?` link. From-address bound to the org. *Source: phishing fatigue; legitimate emails feel like the scams users are trained to delete. ([Bitdefender](https://www.bitdefender.com/en-us/blog/hotforsecurity/signing-contracts-with-docusign-watch-out-for-these-phishing-scams))*

**R-2. Signing landing page leads with sender identity, document name, and a one-sentence summary of what is being agreed to — *above* any field.** No upsell, no account-creation pressure, no "create an account" CTA. *Source: Documenso's praised flow vs. DocuSign's account-creation funnel. ([sliplane comparison](https://sliplane.io/blog/5-open-source-docusign-alternatives))*

**R-3. UETA/ESIGN-aware consent step before any field is presented.** Affirmative checkbox: right to receive paper records, right to withdraw consent, hardware/software requirements, retention policy. Recorded as a discrete `consent_given` audit event. *Source: ESIGN/UETA requirements; courts treat the affirmative click as primary enforceability evidence. ([Ironclad](https://ironcladapp.com/journal/contract-management/electronic-signature-law))*

**R-4. Mobile signing renders the contract as responsive HTML for reading; PDF view available as a toggle; sealing is against the PDF.** Field minimum touch target ≥ 44×44 CSS px. *Source: 35% mobile pinch-zoom abandonment cliff. ([eSign Global](https://www.esignglobal.com/blog/mobile-responsive-signing-experience))*

**R-5. Drawn-signature canvas defaults: large modal (≥ 320px wide on mobile, ≥ 640px on desktop), stroke ≥ 2.5px with pressure-style tapering, dark ink, "Clear" button always visible, 2× supersampling at stamp time so it doesn't look thin and faint.** *Source: DocuSign Community threads on faint/small signatures. ([DocuSign Community](https://community.docusign.com/esignature-111/signatures-are-too-small-and-faint-5277))*

**R-6. Typed signature is a first-class peer of drawn — never a fallback.** Equal visual weight in the modal. Required for keyboard-only and assistive-tech signers. *Source: WCAG keyboard guidance. ([eSign Global accessibility](https://www.esignglobal.com/blog/accessibility-compliance-wcag-electronic-signature))*

**R-7. Field-by-field guided navigation with a persistent "Next required field" CTA, auto-scroll, and a remaining-required-fields counter.** Tab order matches required order. *Source: Adobe's praised "5-minute completion" once familiar; counter-balances DocuSign new-UI multi-step regressions. ([G2 Adobe](https://www.g2.com/products/adobe-acrobat-sign/reviews?qs=pros-and-cons))*

**R-8. Final "Confirm & Sign" is a separate, deliberate step from filling fields.** Summary of filled values + signature thumbnail + single primary button. No "double-click on the signature field to commit." *Source: Adobe's broken undo button + DocuSign mis-click → restart complaints. ([G2 Adobe](https://www.g2.com/products/adobe-acrobat-sign/reviews?qs=pros-and-cons))*

### Sender experience

**R-9. Envelope status shown as a horizontal stepper of named recipients, not a vague "In progress."** Each step: name, email (masked), state (waiting / opened / signed / declined), timestamp. Surfaced on dashboard tile *and* envelope detail. *Source: pervasive opacity complaints across DocuSign and SignWell. ([G2 SignWell](https://www.g2.com/products/signwell/reviews?qs=pros-and-cons))*

**R-10. Sender dashboard surfaces "stuck" envelopes by default.** Default sort: oldest unanswered first, with aging indicator (e.g., "waiting on Alice — 3 days"). *Source: same opacity theme.*

**R-11. Per-recipient field color coding in the builder.** Recipient list panel doubles as a legend. Recipients can be added as named *roles* before real emails are known so templates work cleanly. *Source: DocuSign color-coding is one of its few uncontested UX wins; role-as-placeholder enables templates and bulk send. ([DocuSign Community](https://community.docusign.com/docusign-maestro-80/how-to-drop-and-drag-esignature-fields-855), [Juro on DocuSign templates](https://juro.com/learn/docusign-templates))*

**R-12. Decline and void must be one click away with a required reason field.** Triggers immediate notifications. *Source: PandaDoc and Adobe pain around in-flight changes. ([G2 PandaDoc](https://www.g2.com/products/pandadoc/reviews))*

**R-13. Email branding on outbound mail and the signing page is built-in, not a paid upgrade.** Org logo, org display name, configurable "from" sender name. *Source: SignWell and Dropbox Sign branding-customization complaints. ([G2 SignWell pros/cons](https://www.g2.com/products/signwell/reviews?qs=pros-and-cons))*

**R-14. Recipient privacy is configurable.** Default: each recipient sees only their own fields and the document. Optional: "Show all recipients on this envelope" for transparency cases. (DocuSign cannot do per-recipient hiding at all — explicit improvement.) *Source: [DocuSign Community envelope-visibility thread](https://community.docusign.com/esignature-111/envelope-visibility-2485).*

### Audit & integrity

**R-15. Audit trail presented as a full event timeline by default — *not* a one-page certificate.** Sender sees a per-envelope timeline (open, view, field-focus, sign, download, etc.) in the UI. Downloadable signed JSON. Sealed PDF gets *both* a human-readable audit page *and* the embedded signed JSON. *Source: certificate-vs-trail confusion in disputes; Anvil's schema discussion. ([useanvil](https://www.useanvil.com/blog/engineering/e-signature-audit-trail-schema-events-json-checklist/))*

**R-16. Cryptographic audit chain: every event includes `prev_hash`, `event_hash`, and an Ed25519 signature.** This is the gap none of the OSS priors close. UM's regulated context demands it. *Source: prior-art review showed Documenso, DocuSeal, and OpenSign all use plain rows with no chain. ([Documenso audit-log types](https://github.com/documenso/documenso/blob/main/packages/lib/types/document-audit-logs.ts))*

**R-17. Snapshot the template/field definition into the envelope at creation time.** Edits to the source template after the envelope is sent do not retroactively change in-flight envelopes. *Source: DocuSeal's `submission.template_fields_snapshot` pattern. ([DocuSeal migrations](https://github.com/docusealco/docuseal/tree/master/db/migrate))*

**R-18. Hashed tokens in DB, never plaintext.** Signing tokens are JWS-signed and short-lived (signature is the secret); persistence stores `jti` to enforce single-use. API tokens and password-reset tokens stored as SHA-256 hashes only. *Source: Documenso stores raw `Recipient.token` (anti-pattern); DocuSeal hashes its `access_tokens.sha256` (the right pattern).*

### Accessibility

**R-19. Signing ceremony specifically is keyboard-accessible end-to-end.** Consent → fields → confirm → done, with focus management correct on each route change, focus visible, ARIA labels on the signature canvas, typed-signature available. axe automated audit in Playwright on the signing routes specifically. *Source: WCAG keyboard guidance + DocuSign's only-partial VPAT conformance. ([Level Access](https://www.levelaccess.com/blog/keyboard-navigation-complete-web-accessibility-guide/))*

---

## What the OSS prior art tells us about schema

(Detail in `SCHEMA.md`. Highlights here.)

- **Unify `Envelope` and `Template` into one table with a `type` discriminator.** *(Documenso pattern.)* One set of queries, one validation surface, one set of permissions. A template is just an envelope you can clone.
- **Separate `EnvelopeItem` from `DocumentFile`.** *(Documenso pattern.)* Lets us support multi-file envelopes in v1 essentially for free, and lets us replace files (versioning) without rewriting the envelope.
- **`signingOrder` enum at envelope level + integer `signingOrder` per recipient.** *(Documenso pattern.)* Same integer = parallel group. Trivially expressible.
- **Two audit streams: envelope events + account-security events.** *(Documenso pattern.)* Different consumers, different access controls. Don't mix.
- **Email-deliverability events as their own table.** *(DocuSeal `email_events`.)* Bounces/complaints/deliveries are signal but not first-class audit events.
- **Background-job durability table.** *(Documenso pattern.)* Don't fire-and-forget critical transitions (advance-to-next, finalize-seal); persist them, retry.
- **Audit logs FK with `onDelete: Restrict`** (NOT `Cascade` like Documenso). Audit logs must outlive their envelopes; otherwise deleting an envelope evidence-launders its history.

---

## What the OSS prior art tells us NOT to do

1. **No audit-chain integrity.** All three priors leave audit logs as plain rows.
2. **Per-tenant private keys in the application DB** (OpenSign): a DB dump compromises every tenant's signing identity. Keys live on a dedicated locked-permission volume.
3. **Persistent slug-as-token signing tokens** (DocuSeal `submitter.slug`, OpenSign similar): effectively permanent until expiration. We use signed, single-use, time-bounded JWS.
4. **Storing the live signing token in DB** (Documenso `Recipient.token`): we store the JWS token-hash or `jti` only.
5. **Mixing the audit-page render path with the signing path** (OpenSign emails the audit certificate as a separate file): we bind the audit/manifest into the sealed PDF so they cannot be detached.
6. **Cascading deletes on audit-log FKs.** `onDelete: Restrict`.
7. **Signature images as inline base64 strings** (Documenso): fine for v1 but document the upgrade path to object storage with a content-addressed key.
8. **Roles array on User without a clear permission matrix** (Documenso): use a role enum on `OrgMember` with a centralized `can()` function instead.

---

## Sources

### Competitive UX

- DocuSign: [G2 reviews](https://www.g2.com/products/docusign/reviews), [Pros/Cons](https://www.g2.com/products/docusign/reviews?qs=pros-and-cons), [Certinal review summary](https://www.certinal.com/blog/docusign-reviews-insights-and-feedback), [Community: faint signatures](https://community.docusign.com/esignature-111/signatures-are-too-small-and-faint-5277), [Community: envelope visibility](https://community.docusign.com/esignature-111/envelope-visibility-2485), [Community: drag-and-drop fields](https://community.docusign.com/docusign-maestro-80/how-to-drop-and-drag-esignature-fields-855), [signing order blog](https://www.docusign.com/en-gb/blog/quick-tip-setting-signing-order), [accessibility blog](https://www.docusign.com/blog/making-the-signing-experience-accessible-to-all), [mobile signing blog](https://www.docusign.com/blog/mobile-signing-experience-customers), [Trust safety alerts](https://www.docusign.com/trust/safety-alerts), [Bitdefender phishing piece](https://www.bitdefender.com/en-us/blog/hotforsecurity/signing-contracts-with-docusign-watch-out-for-these-phishing-scams)
- Adobe Acrobat Sign: [G2 Pros/Cons](https://www.g2.com/products/adobe-acrobat-sign/reviews?qs=pros-and-cons), [G2 reviews](https://www.g2.com/products/adobe-acrobat-sign/reviews), [Signeasy aggregation](https://signeasy.com/blog/business/adobe-sign-reviews)
- Dropbox Sign: [G2 reviews](https://www.g2.com/products/dropbox-sign-formerly-hellosign/reviews), [Pros/Cons](https://www.g2.com/products/dropbox-sign-formerly-hellosign/reviews?qs=pros-and-cons), [Capterra](https://www.capterra.com/p/144797/HelloSign/reviews/)
- PandaDoc: [G2](https://www.g2.com/products/pandadoc/reviews), [Trustpilot](https://www.trustpilot.com/review/pandadoc.com), [Capterra](https://www.capterra.com/p/131735/PandaDoc/reviews/)
- SignWell: [G2 Pros/Cons](https://www.g2.com/products/signwell/reviews?qs=pros-and-cons), [G2](https://www.g2.com/products/signwell/reviews), [Research.com](https://research.com/software/reviews/signwell-review)
- Cross-product: [eSign Global mobile responsive signing](https://www.esignglobal.com/blog/mobile-responsive-signing-experience), [eSign Global WCAG](https://www.esignglobal.com/blog/accessibility-compliance-wcag-electronic-signature), [Level Access keyboard nav](https://www.levelaccess.com/blog/keyboard-navigation-complete-web-accessibility-guide/), [Ironclad ESIGN/UETA](https://ironcladapp.com/journal/contract-management/electronic-signature-law), [Anvil audit-trail schema](https://www.useanvil.com/blog/engineering/e-signature-audit-trail-schema-events-json-checklist/), [Adobe audit-trail explainer](https://www.adobe.com/acrobat/business/hub/esignature-audit-trail.html), [Juro DocuSign templates](https://juro.com/learn/docusign-templates), [Sliplane OSS DocuSign alternatives](https://sliplane.io/blog/5-open-source-docusign-alternatives)

### OSS prior art

- Documenso: [schema.prisma](https://github.com/documenso/documenso/blob/main/packages/prisma/schema.prisma), [audit-log types](https://github.com/documenso/documenso/blob/main/packages/lib/types/document-audit-logs.ts), [PDF utilities](https://github.com/documenso/documenso/tree/main/packages/lib/server-only/pdf), [signing package](https://github.com/documenso/documenso/tree/main/packages/signing), [changelog](https://documenso.com/changelog)
- DocuSeal: [migrations](https://github.com/docusealco/docuseal/tree/master/db/migrate), [lib](https://github.com/docusealco/docuseal/tree/master/lib), [API docs](https://www.docuseal.com/docs/api), [audit-trail FAQ](https://www.docuseal.com/faq/what-is-an-audit-trail-in-a-pdf-signature)
- OpenSign: [GitHub root](https://github.com/OpenSignLabs/OpenSign), [PDF.js cloud function](https://github.com/OpenSignLabs/OpenSign/blob/main/apps/OpenSignServer/cloud/parsefunction/pdf/PDF.js)
