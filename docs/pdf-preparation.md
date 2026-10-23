# Preparing an uploaded PDF

Upload a PDF, then choose **Edit PDF** beside the filename or in document preparation.

- Select a page and rotate left/right, rotate all pages, move earlier/later, or delete it. At least one page must remain.
- Choose **Add text**, enter text, and click its position. Choose **Highlight** and drag across an area. Text is fitted inside its box; the preview renders the same PDF content that is saved.
- **Undo** restores up to 40 editing steps. **Cancel** leaves the uploaded file untouched. **Apply changes** updates the working PDF; Save draft or Send persists it through the normal upload flow.
- Existing signing fields follow rotation and page order. Deleting a page removes its fields, with a notice. Deletion is refused if it would break formulas or recipient/field conditions.

The original upload file on your computer is untouched. Edits are available while preparing a new envelope, before sending. The uploader accepts readable PDFs up to 25 MB and 2,000 pages. Editing existing paragraphs/images or converting Word documents is outside this version.

Native form appearances are baked into the prepared PDF. PDFs with unsupported existing annotations, XFA, optional-content widgets or NoRotate widgets must first be exported as flattened PDFs; editing surfaces an error instead of silently discarding those features. Added text uses Helvetica's Latin character repertoire; unsupported characters produce an error. Highlights and new text are flattened into page content, not editable native PDF comments.

## AI field review

In document preparation, choose **AI: Suggest fields** for a document, then **Analyze document**. Detection uses current page images and positioned text, so a configured vision-capable provider can also analyze scanned pages. Opening the dialog does not transmit document content.

Suggestions appear on the page and in a review list. Click a suggestion to change its type, label, recipient, required state, position or size. Deselect unwanted fields; **Add selected fields** creates ordinary builder fields. Required defaults off. You can then adjust those fields using the existing editor. Duplicate suggestions are filtered against placed fields. AI labels are made unique across the envelope to preserve formula references.

You may stop analysis or close the dialog. Completed pages remain available while the dialog is open; retry analyzes unfinished pages. Closing discards unaccepted suggestions. The configured request limit can pause longer documents; wait and retry to continue.

See [AI provider configuration](ai-field-suggestions.md). This optional feature stays disabled until the operator supplies a compatible endpoint and model. Real-model quality varies and should be evaluated using representative documents.

## Verification

```sh
npm test
npm run typecheck
npm run build
npm exec playwright -- test -c playwright.pdf.config.ts
```

The dedicated browser harness runs the actual builder and PDF dialogs on localhost using synthetic PDFs. It replaces only the server submit boundary with a capture function and the AI API with deterministic responses; it does not use a database, send mail, or contact an AI provider. It checks edited PDF bytes at submission, annotation pixel fidelity, field acceptance/remapping, deduplication, cancellation and failed-page retry on desktop and mobile. Separate unit and raster tests cover PDF sealing geometry/form appearances and API access/provider validation. Deployment-specific signing and real-provider quality are separate integration checks.
