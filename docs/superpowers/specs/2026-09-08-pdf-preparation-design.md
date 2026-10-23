# PDF preparation and AI field suggestions

Approved in chat on 2026-09-08. Extend the existing new-envelope builder. PDFs remain the accepted upload format.

## PDF editing
An Edit PDF dialog provides page previews, clockwise/counterclockwise page rotation, rotate-all, move earlier/later, delete, text and highlight annotations, undo, cancel and apply. Edits update the actual File sent to the existing upload action. Keep edits local until save/send. Preserve a working source and undo state in the dialog; cancel leaves the builder untouched. Existing field boxes follow page reordering and rotation; deleted-page fields are removed with visible notice. Refuse deletion when it would break field dependencies. Normalize edited pages into displayed orientation so signing and sealing use the same geometry. Reuse PDF.js and pdf-lib. No rewriting existing paragraphs, DOCX conversion, or editing sent envelopes.

## AI suggestions
A per-document AI: Suggest fields dialog renders the document and overlays candidate boxes with editable type, position/size, label and recipient. Users select suggestions to accept or dismiss; accepted suggestions become ordinary builder fields. Include signature, initials, date, text, number, checkbox, name, email, phone, address, company and job title. Do not infer legal necessity; required state is editable and defaults false. Never send an envelope or insert a signature through analysis.

Render current page images plus positioned text using PDF.js, process pages individually, show progress and cancellation. Use an authenticated, permission-checked, rate-limited server endpoint to call an operator-configured vision-capable chat-completions-compatible AI service. Endpoint URL/model/key come exclusively from server configuration. Bound request/response bytes, text and output field counts; validate schema, finite normalized geometry and supported types. Treat document content as untrusted input. No document content or provider credentials in logs. Default disabled without configuration, with an actionable explanation. Support partial page success with explicit errors and retry. Filter duplicate suggestions against existing fields and each other. A closed dialog cannot apply late results.

## Verification
Test PDF page geometry/content, rotation/remapping and annotations using actual generated PDFs; test detection validation, provider failures, authorization and duplicates. Exercise editor and suggestions in the browser with deterministic API responses. Run unit suite, typecheck and production build. Real-model quality requires a configured provider and representative documents and must be stated separately from mocked integration verification.
