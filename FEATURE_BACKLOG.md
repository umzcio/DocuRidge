# DocuRidge — Feature Backlog vs DocuSign Next-Gen

Source: DocuSign "Next Gen eSignature Experience" article (30-Mar-2026), cross-referenced
with general DocuSign sender / signer feature set. Scope: every gap is in scope to
build. Order below reflects implementation dependency, not priority — earlier items
unlock the later ones.

Status legend: ☐ not started · ⌛ in progress · ✓ done · ⏭ deferred

---

## 1. Expanded field types

### 1A. Simple text-shaped types  ⌛
- ☐ `NUMBER` — integer/decimal with min/max validation
- ☐ `PHONE` — formatted phone, prefills from `User.phone` if known
- ☐ `ADDRESS` — multi-line, prefills from `User.address`
- ☐ `COMPANY` — single-line, prefills from `User.company`
- (`NAME`, `EMAIL`, `JOB_TITLE` already shipped)

### 1B. Selection types (need options array)
- ☐ `DROPDOWN` — single-select from sender-defined options
- ☐ `RADIO` — exclusive group, each option a separate visual position

### 1C. Action / annotation types
- ☐ `APPROVE` — recipient action; clicking marks the doc "Approved" by that recipient
- ☐ `DECLINE` — recipient action; declines without signing
- ☐ `STAMP` — sender or recipient stamps an image (initial stamp, "Approved" graphic)
- ☐ `NOTE` — annotation visible on doc, not part of contract data
- ☐ `DRAWING` — freehand region (used for sketches, marks)
- ☐ `LINE` / `STRIKETHROUGH` — sender-drawn redaction or strikethrough lines on the doc

### 1D. Calculated / conditional
- ☐ `FORMULA` — calculated field (`= subtotal * 0.07`, `= concat(name, ", ", title)`)
- ☐ `ATTACHMENT` — recipient uploads a supporting file during signing

---

## 2. Per-field properties

Builder properties pane — accessible via gear icon on the per-field contextual toolbar.

- ☐ `Read only` toggle (sender pre-fills, recipient cannot edit)
- ☐ `Required` toggle (already shipped — keep)
- ☐ `Default value` (already shipped as `defaultValue` — surface in UI)
- ☐ `Character limit` (max length for text/number)
- ☐ `Data label` (machine-readable name for export/integration)
- ☐ `Validation`
  - regex pattern + custom error message
  - min/max for numbers
  - allowed values for text (e.g. UM ID format)
- ☐ `Formatting` (font, size, color per field — config'd at org level by default)
- ☐ `Location and Autoplace` — anchor-tag detection: PDF text contains `/sn1/` markers
  that auto-create fields on import
- ☐ `Conditional logic` — "show this field only if field X equals Y"

---

## 3. Builder UX

Inspired by DocuSign's contextual menu + properties pane redesign.

- ☐ Per-field contextual toolbar (floating above selected field): recipient swap,
  required/optional toggle, copy, delete, gear → properties
- ☐ Multi-select fields with shift-click; alignment controls in the toolbar (left,
  right, top, bottom, distribute horizontally / vertically)
- ☐ Field categories in palette (Standard, Custom, Action, Other) with category
  dropdown + inline search
- ☐ Document thumbnails sidebar (page-by-page nav for multi-page PDFs)
- ☐ Anchor-tag autoplace: scan uploaded PDF text for `/sig1/`, `/init1/`, `/dt1/`
  markers → auto-create fields, hide markers in display

---

## 4. Sender-prep flow

- ☐ "Sender" pseudo-recipient in the recipient dropdown — sender pre-fills fields
  *before* sending; recipient sees the values as read-only or editable per setting
- ☐ Field libraries — user-saved field configurations (e.g. "UM tuition waiver
  field set") reusable across templates
- ☐ Save fields-only as a partial template
- ☐ Conditional routing — recipient B is routed only if recipient A's field equals X
- ☐ Supplemental documents — read-only attachments shown alongside the contract
  (e.g. policy PDF, instructions)

---

## 5. Signing-ceremony enhancements

- ☐ Comments per field / per document — sender ↔ recipient back-channel during
  signing, recorded in the audit trail
- ☐ Recipient attachments — upload supporting file as part of completing
- ☐ Apply-to-all initials — single click stamps every initials field on the doc
- ☐ User-level saved signature — signed-in recipient adopts once, reused on every
  future envelope (currently we re-capture per envelope)
- ☐ Finish-later / resume signing — recipient leaves and comes back; partial
  field values + signature persisted, single-use token re-issuable to same recipient
- ☐ Print-and-sign fallback — recipient can download blank PDF, sign physically,
  upload back; sender approves the upload as the recipient's signing act
- ☐ Reassign-by-recipient — recipient delegates to another email with full audit
- ☐ Multi-language signing UI — Spanish at minimum
- ☐ Keyboard-only field navigation (Tab next, Shift-Tab prev, Enter to open modal)

---

## 6. Recipient roles beyond SIGNER / CC

- ☐ `APPROVER` — reviews the document, gates routing, no fields required
- ☐ `IN_PERSON_SIGNER` — host model: sender hands device to a person standing next
  to them, host attests; signer can be unauthenticated
- ☐ `WITNESS` — additional required signature on a single signer's act
- ☐ `EDITOR` — sender's delegate who can prep fields before sending

---

## 7. Org/account features

- ☐ Folders + tags for envelope organization on the dashboard
- ☐ Bulk dashboard actions (void / delete / move multiple envelopes)
- ☐ Envelope clone (new envelope from a completed one)
- ☐ Forward-completed (send a sealed PDF to additional recipients)
- ☐ Convert envelope → template (already shipped)
- ☐ Cloud storage delivery — auto-push sealed PDF to user-configured Google Drive /
  OneDrive / Dropbox folder
- ☐ Webhooks ("Connect") — push envelope events to external HTTP endpoints
- ☐ Brand customization — primary color, header text, email body template at org
  level (logo already shipped)
- ☐ Default field font configurable at org level
- ☐ Document retention / auto-purge policy

---

## 8. Power Forms / Web Forms

- ☐ Public-link form: visitor fills the form and a new envelope auto-creates with
  their data prefilled. Strong UM fit for self-service intake (tuition waiver, etc.)

---

## 9. Bulk send (separate phase)

- ⌛ CSV upload → one envelope per row from a chosen template (Phase 6 in main plan)

---

## Out of scope for this initiative

These remain explicitly deferred per the original `CLAUDE.md`:

- ⏭ SSO / SAML / OIDC (UM CAS/Shibboleth integration is a deployment-time concern)
- ⏭ KBA / SMS / ID-Verify multi-factor signer auth
- ⏭ Cloud KMS / HSM key custody
- ⏭ Native iOS/Android apps (responsive web only)
- ⏭ DocuSign-AI features: Agreement-Type detection, Recommended Fields,
  Navigator passthrough, Salesforce Fields integration
- ⏭ White-label / multi-tenant beyond a single org

---

## Implementation order (working list)

Working sequentially through these. Each item ships fully (schema, migration,
server action, UI, tests, docs) before moving to the next.

1. **§1A — simple new types** (NUMBER, PHONE, ADDRESS, COMPANY)
2. **§2 partial — per-field properties** (read-only, character-limit, default-value
   surfacing, basic regex validation) — needed before DROPDOWN/RADIO
3. **§1B — selection types** (DROPDOWN, RADIO with options array)
4. **§3 — anchor-tag autoplace + per-field contextual toolbar + multi-select alignment**
5. **§2 conditional logic + §4 conditional routing**
6. **§1D — FORMULA + ATTACHMENT**
7. **§1C — action/annotation types** (APPROVE, DECLINE, STAMP, NOTE, DRAWING, LINE)
8. **§5 — signing-ceremony enhancements** (comments, apply-to-all initials,
   user-level saved signature, finish-later, reassign)
9. **§6 — additional recipient roles**
10. **§4 + §7 — sender pseudo-recipient, supplemental docs, bulk dashboard actions,
    folders/tags, envelope clone**
11. **§7 — webhooks, cloud storage delivery, brand customization expansion**
12. **§5 — multi-language UI**
13. **§8 — Power Forms**
14. **§9 — Bulk send (Phase 6 in main plan)**
