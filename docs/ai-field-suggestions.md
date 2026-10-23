# AI field suggestions

AI suggestions are optional and disabled by default. An operator must set both `DOCURIDGE_AI_BASE_URL` (an API root such as `https://provider.example/v1`) and `DOCURIDGE_AI_MODEL` to a vision-capable model. Set `DOCURIDGE_AI_API_KEY` when the provider requires bearer authentication. An unauthenticated local HTTP endpoint is supported. Never use `NEXT_PUBLIC_` variables for these settings.

The app appends `/chat/completions` to the API root. The provider must accept image inputs using `image_url` with JPEG data URLs, `response_format: {"type":"json_object"}`, `max_tokens`, and system/user messages. It must return JSON in `choices[0].message.content` with `finish_reason: "stop"`. The wire format follows the [official OpenAI Chat Completions API](https://developers.openai.com/api/reference/typescript/resources/chat/subresources/completions/methods/create); compatible providers may differ in their supported model features. Choose a model that supports all of the request parameters. There is no automatic provider fallback.

Set the variables in the deployment environment or `.env`, then restart/recreate the app. The existing Docker Compose `env_file: .env` passes them through without additional Compose settings. These values are read only by the server. Missing or malformed configuration reports the feature as disabled. No actual provider credentials or documents were used during implementation tests.

For Ollama running on the Docker host, Compose maps `host.docker.internal` to the host gateway. Configure:

```dotenv
DOCURIDGE_AI_BASE_URL=http://host.docker.internal:11434/v1
DOCURIDGE_AI_MODEL=qwen3.8:27b
DOCURIDGE_AI_API_KEY=
```

Ollama must be listening on an address reachable from the app container. Recreate the app with `docker compose up -d --no-deps --wait app` after changing these values. The installed `qwen3.8:27b` model was verified locally on September 8, 2026, through the actual provider adapter: a synthetic page returned valid name, signature, and date fields in about 10 seconds. This confirms connectivity and basic vision interoperability; users should still review suggested placements on their documents.

When a user requests analysis, the app sends the current page's JPEG preview and extracted, positioned text to the configured provider. No PDF upload or provider request happens just by opening an envelope builder. Review the provider's retention settings before enabling analysis for your documents. The app does not log page content, provider response bodies, or credentials. The provider is instructed to treat document content as untrusted data, ignore embedded instructions, and suggest empty fields only. Suggestions do not establish legal necessity, sign, send, or automatically populate an envelope. Users review and accept them, and required state defaults to false.

Before showing suggestions, the browser refines signature and initials boxes against thin horizontal rules in the rendered page. It aligns a box above a uniquely matching nearby line only when there is clear space and the move does not increase overlap with another suggested or existing field. Distant, ambiguous, occupied, or already matched lines are left alone. This works from rendered pixels for both scanned and vector documents; it does not add fields or change other field types. Tilted, faint, dotted, or unruled signing areas may retain the model's original estimate and need manual adjustment.

The provider prompt explicitly places the bottom of a signature/initials box at or above the signing line (`y + h <= lineY`). The refinement also recognizes a box whose top starts at or just below a nearby line, moving it above that line. It prefers an already aligned bottom edge when both borders of a rectangular field are present. Earlier bottom-edge-only matching could leave an entirely below-line box unchanged; regression tests cover boxes crossing, starting at, and starting below the line.

Checkbox suggestions are aligned and resized to nearby small, empty, four-sided squares detected in the same page image. The detector excludes filled squares, circles, text, and large rectangles. It uses physical pixel dimensions so a square remains square on portrait and landscape pages. Clearly matched neighboring options can resolve an estimate between two squares; competing or unresolved matches remain unchanged. Proposed placements are checked together for additional overlap with other suggestions and existing fields. No new checkboxes are invented, and printed choices are not automatically selected.

`src/lib/ai/checkbox.live.test.ts` is an opt-in regression for the seven-checkbox parking form, using an explicitly supplied upright local PDF and local Qwen only. Run it with `DOCURIDGE_AI_CHECKBOX_PDF=/path/to/upright-parking-form.pdf npm exec vitest -- run src/lib/ai/checkbox.live.test.ts`. The PDF is not bundled with the repository; temporary geometry reports and preview images are written under `/tmp/docuridge-parking-*`.

`GET /api/ai/field-suggestions` returns `{ "enabled": boolean }`. `POST` accepts one page as `{ "image": "data:image/jpeg;base64,...", "text": "...", "page": 1 }` and returns `{ "suggestions": [...] }`. Each suggestion has `type`, `page`, `x`, `y`, `w`, `h`, `label`, and `confidence`. Coordinates use normalized displayed-page dimensions with a top-left origin. Width and height must each be at least 0.005 and the box must fit inside the page. Empty labels default to the field type. Supported types are `SIGNATURE`, `INITIALS`, `DATE`, `TEXT`, `NUMBER`, `CHECKBOX`, `NAME`, `EMAIL`, `PHONE`, `ADDRESS`, `COMPANY`, and `JOB_TITLE`.

Both methods require a signed-in ADMIN or SENDER with `envelope:create` permission. POST also requires an exact `Origin` matching the origin of `PUBLIC_URL` or an entry in `TRUSTED_ORIGINS`. Unlike the general middleware, this route rejects missing origins, `null`, and unconfigured loopback origins. Alternate deployment front doors must be listed explicitly. All responses have `Cache-Control: no-store`.

Analysis may run before a signer has been added. The review dialog lets the sender add a signer by name and email without closing the dialog or discarding the suggestions. Existing unassigned suggestions are assigned to that signer; adding fields only updates document preparation and does not send or save the envelope. The footer explains when adding fields is unavailable (analysis in progress, no selected fields, or no signer). Copy-only and approval-only recipients cannot receive signing fields.

Limits:

- 20 analysis requests per minute per organization/user, using the existing database rate limiter.
- 6 MiB incoming JSON bytes, bounded during stream reads even without `Content-Length`.
- About 4 MiB decoded JPEG, 24,000 text characters, and a positive page number no larger than 2,000.
- 256 KiB provider response bytes, at most 80 fields, and labels of at most 120 characters.
- 45 seconds for the provider request including response-body reads. Browser cancellation aborts the provider request and pending body reads.

Unsupported types, non-finite geometry, boxes outside the page, extra field properties, wrong page numbers, truncated responses, tool calls, refusals, malformed JSON, and excessive field counts reject that page's response. Overlapping suggestions of the same page and type are deduplicated at 50% intersection-over-union; the review dialog also filters against existing fields. A failed page can be retried independently. Status codes include 400 (invalid input), 401/403 (access/origin), 413 (body too large), 415 (content type), 429 (rate limit with `Retry-After`), 499 (cancelled), 502 (provider/response failure), 503 (disabled/unavailable), and 504 (timeout). Provider errors are deliberately sanitized.

The tests use deterministic, in-memory HTTP responses and synthetic page payloads. They verify validation, authentication/permissions, origin checks, throttling, byte limits, cancellation, timeout, and duplicate filtering. Real-model detection quality and provider-specific interoperability still require a configured provider and representative, authorized test documents.

## Local placement comparison (September 8, 2026)

Three generated PDFs place two signature lines and two date lines per page, with signature labels below, above, and beside the lines. Both models received identical rendered pages, extracted text, and the provider prompt in place at the time of comparison, before the explicit above-line instruction was added. No user documents were used.

| Model | Results with the current adapter | Signature placement |
| --- | --- | --- |
| `qwen3.8:27b` | All 12 fields found; 6–12 seconds per page | Raw signature baseline-center errors ranged from 6.3 to 18.0 PDF points in the comparison run. Refinement aligned all six to their known baselines and horizontal extents. |
| `qwen3-vl:32b` | First page completed in 37 seconds; second returned an invalid response; third hit the 45-second timeout | About 54 PDF points of signature baseline-center error on the completed page; outside the conservative refinement range. |

The deployment retains `qwen3.8:27b` with placement refinement. These are small synthetic interoperability and alignment checks, not a general model ranking or a guarantee on arbitrary documents.

The opt-in live test is `src/lib/ai/placement.live.test.ts`. Run `DOCURIDGE_AI_LIVE_TEST=1 DOCURIDGE_AI_TEST_MODELS=qwen3.8:27b npm exec vitest -- run src/lib/ai/placement.live.test.ts` against local Ollama. To compare models, supply a comma-separated model list. The harness saves generated PDF/image artifacts and a JSON report under `/tmp/docuridge-placement-*`. The test is skipped during normal unit runs.
