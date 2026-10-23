# PDF Preparation Implementation Plan

> Execute the approved design using focused tasks and test-first checks; integrate and review the whole feature before completion.

**Goal:** Edit uploaded PDFs and review AI-suggested signing fields in the existing builder.
**Architecture:** Separate pure PDF geometry/edit functions, server AI adapter/route, and client preparation dialogs. Reuse current upload and field persistence.
**Tech Stack:** Next.js, React, PDF.js, pdf-lib, Zod, Vitest, Playwright.
**Spec:** docs/superpowers/specs/2026-09-08-pdf-preparation-design.md

## Global constraints
Preserve existing uncommitted work. No new runtime dependencies. No external document transmission during development tests. Keep provider credentials server-side. No deployment or real mail sends.

## Tasks
- [x] 1. PDF editing core: src/lib/pdf/edit.ts and edit.test.ts. Export PdfPageEdit {sourcePage: number (1-based), rotation: number (clockwise delta)}, PdfAnnotation {page: number (output 1-based), kind: 'text'|'highlight', x,y,w,h: number (normalized), text?: string}, applyPdfEdits(bytes: Uint8Array, pages: PdfPageEdit[], annotations?: PdfAnnotation[]): Promise<Uint8Array>, remapFieldsForPages<T extends {page:number;x:number;y:number;w:number;h:number}>(fields:T[],pages:PdfPageEdit[]):T[]. Test actual PDFs and bounds, rotation, reorder/delete, text/highlights, four rotations, source rotations and crop boxes. Ensure sealed output respects source rotation by sharing upright-page embedding where required. Write failing tests, implement, run targeted suite.
- [x] 2. AI core and API: src/lib/ai/field-suggestions.ts, provider.ts, associated tests; src/app/api/ai/field-suggestions/route.ts; configuration/docs. Shared request {image:string (JPEG data URL), text:string, page:number}; response {suggestions: {type,page,x,y,w,h,label,confidence}[]}. GET returns {enabled:boolean}; POST accepts one page. Validate request geometry/output and provider response. Export filterDuplicateSuggestions(candidates,existing) with compatible field boxes. Use server environment variables DOCURIDGE_AI_BASE_URL (API root ending /v1), DOCURIDGE_AI_MODEL, DOCURIDGE_AI_API_KEY (optional local auth). Bound parsing, rate-limit and authenticate. Test failure paths before implementation.
- [x] 3. Client dialogs: src/components/pdf/pdf-preview.tsx, pdf-editor.tsx, field-suggestions-dialog.tsx. PDF editor accepts file and onApply(file,pages); AI dialog accepts document, existingFields and recipients, produces accepted fields via callback. Implement cancellation, errors, progress, editable review overlays and undo. Add browser behavior tests before wiring.
- [x] 4. Builder integration: src/app/dashboard/envelopes/new/form.tsx. Add per-document entry points, preserve and remap fields on edits, guard dependencies on deletion, apply accepted fields with new IDs and recipient assignments. Fix upload parse errors rather than creating fake one-page records. Ensure edited files reach DocumentRefs. Keep existing field UI and tag detector.
- [x] 5. Verify and review: targeted tests, full npm test, npm run typecheck, npm run build; browser tests with stubbed provider response plus real PDF edit/save. Review feature diff without including unrelated pre-existing changes. Record real-provider testing limits.

## Progress
Baseline recorded before implementation. Work is authorized by the user's “yes - lets roll”; routine implementation choices and tests proceed without additional approval.

Implementation notes: source rotation/crop/UserUnit normalization is shared with sealing. Form appearance flattening was corrected after raster review to preserve visibility, transformed bounds and missing appearances. AI labels are unique and deleted-page dependency checks cover both IDs and labels. Staged annotation previews render actual edited PDF bytes. Reviewed with no remaining important findings. Initial full suite:451 passing. Desktop/mobile browser checks:10 passing before the final pixel-fidelity regression was added. Final verification follows.

Final verification:451 unit tests across33 files pass;12 browser scenarios pass across desktop and mobile, including pixel-identical annotation preview/saved output. Typecheck and production build pass. Existing unrelated build lint warnings remain. New builder initial route bundle35.3kB after isolating pure page geometry from lazy PDF editing. No runtime dependencies added, no deployment, no real AI provider or email used. Changes remain in the shared workspace with pre-existing work preserved.
