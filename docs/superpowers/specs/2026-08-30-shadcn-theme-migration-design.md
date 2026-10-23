# DocuRidge UI: shadcn/Radix Migration + Dark Mode — Design Spec

**Date:** 2026-08-30
**Status:** Approved (full migration + dark mode + Tailwind v4, phased execution)
**Baseline:** Working tree includes the session-animation changes (uncommitted); e2e baseline captured before Phase 1.

## Motivation

The codebase has three hand-rolled overlay systems where Radix primitives are
stronger and less code: 11 custom modals, a 228-line custom `Select`
(keyboard nav / outside-click / flip-anchoring re-implemented by hand), and
`<details>`-based topbar menus. `@radix-ui/react-dialog` is a dead dependency.
`components/ui/*` is shadcn-*style* but pre-dates the current shadcn theming
convention (CSS variables, dark-mode sets). Several surfaces (void dialog,
save-template dialog, not-found page) use off-brand stock `neutral-*` classes.

Goal: adopt the shadcn component architecture (Radix primitives + CSS-variable
theming) re-tinted to the existing "Editorial Stationery" palette (DECISIONS.md
D-037), with a shipped dark mode.

## Non-goals (YAGNI)

Tooltip, sheet, drawer, skeleton, chart components. Dark-mode beyond a
topbar toggle + system default. Tailwind v3 compatibility shims after Phase 2.

## Phase 0 — Baseline

Full Playwright e2e run against the isolated `docuridge_e2e` stack on current
code. Result is the reference; any pre-existing failures are recorded, not
fixed in this migration.

## Phase 1 — Tailwind v4 (zero visual change)

- `tailwindcss` v4 + `@tailwindcss/postcss`; drop `autoprefixer`.
- `globals.css`: `@import "tailwindcss";` + `@theme` carrying every token from
  `tailwind.config.ts` (colors, fontFamily, fontSize, borderRadius,
  letterSpacing, keyframes/animation) under the **existing names**.
- Delete `tailwind.config.ts`. `darkMode: 'class'` becomes v4's `@custom-variant dark`.
- Known acceptable drift: v4 shadow/spacing scale subtleties (app is
  pre-production).
- Verify: typecheck, lint, unit tests, e2e green; manual spot-check.

## Phase 2 — Token layer + dark mode

### Variable mapping (light)

CSS variables in `:root`, utilities via `@theme inline`:

| Current | shadcn variable | Value (light) |
| --- | --- | --- |
| `page` | `--background` | `#FAF7F2` |
| `surface` | `--card` (+ `--popover`) | `#FFFFFF` |
| `surface-muted` | `--muted` (+ `--secondary`) | `#F5F0E8` |
| `ink` | `--foreground` (+ `--card-foreground`) | `#1A1A1A` |
| `ink-secondary` | `--muted-foreground` | `#5C5C5C` |
| `ink-tertiary` | `--faint` (custom token) | `#8A8A8A` |
| `hairline` | `--border` | `#E8E2D6` |
| `hairline-strong` | `--input` | `#D4CDBE` |
| `accent` | `--primary` | `#2544FB` |
| `accent-deep` | `--primary-deep` (custom) | `#1A2FBF` |
| `accent-soft` | `--accent` (tinted hover bg) | `#E5E9FF` |
| `accent-ink` | `--accent-foreground` | `#0A163F` |
| `status-declined*` | `--destructive` family | `#9F1F2C` / `#F2E0E2` / `#E2BDC1` |
| `status-completed*` | `--success` family (custom) | as config |

Brand-specific families stay as semantic custom tokens (all var-backed):
`--canvas` (navy DEFAULT `#0A163F` / edge `#1A2855` / line `#2A3A6E`) — dark
surface used by sidebar, primary list buttons, bulk bar, toasts — and the
`--status-*` muted semantic scale (completed/progress/sent/draft/voided).
`--ring` = cobalt at reduced alpha for focus rings. Radius: `--radius: 6px`.

### Dark mode

`.dark` variable set in the navy family: background ≈ `#0B1020`, card ≈ `#131A33`,
foreground ≈ `#ECEDF4`, muted ≈ `#1A2233`, border ≈ `#2A3A6E`, primary brightened
to ≈ `#5B72FF`, status backgrounds deepened / foregrounds brightened to keep
contrast. Values iterated against axe checks, not invented once.

### Mechanics

- `next-themes` (class strategy), `ThemeProvider` in the root layout,
  default = system, sun/moon toggle in the topbar (`lucide-react` icons).
- Sweep all ~34 files using old class names to the new vocabulary; delete old
  names from the theme. One vocabulary, no aliases.
- Existing `prefers-reduced-motion` hammer and `fade-up` / `sig-pulse` /
  `bulk-bar-enter` keyframes survive unchanged.

## Phase 3 — Radix primitives

New shadcn-style components (Tailwind v4 idioms, var-based classes):

- `dialog.tsx` — Radix Dialog. Migration targets: all 11 hand-rolled modals
  (bulk confirm ×2, void, forward, save-template, add-recipient, ceremony
  signature/initials/drawing/value/option-picker, decline, reassign).
- `select.tsx` — Radix Select replaces the custom listbox (6 usages:
  envelope filters, forward expires-picker, add-recipient role, ceremony
  option-picker, templates form, bulk launcher if present).
- `dropdown-menu.tsx` — Radix DropdownMenu for topbar Notifications + Help
  menus (replacing `<details>`).
- `sonner` — replaces the custom Toast in envelope creation; the ceremony's
  inline `role=status` upload indicator stays inline.

Cleanup: delete `src/lib/use-closing.ts`, the `.dialog-overlay/.dialog-panel/
.toast/.select-listbox` CSS, and the related keyframes. Enter/exit motion moves
to CSS transitions on Radix `data-state` attributes (still under 250ms, still
covered by the reduced-motion hammer; `fade-up`, `sig-pulse`,
`bulk-bar-enter` remain).

## Phase 4 — Re-cut remaining `ui/*` + off-brand sweep

- Re-cut to shadcn APIs on the new tokens: `button`, `input`, `card`, `badge`,
  `avatar`, `banner`, `checkbox` (already Radix — re-skin), `divider`,
  `section-label`; add `label.tsx`, `textarea.tsx`.
- Keep app-specific: `wordmark`, `local-time` (token updates only).
- Fold `neutral-*` surfaces (void/save-template dialogs — superseded by
  `Dialog` in Phase 3 — not-found page, any residual stock classes) into the
  token vocabulary.

## Error handling / a11y

Radix provides focus trap, scroll-lock, `aria-modal`, listbox keyboard nav.
Axe-core checks run inside the e2e suite; expected outcome is "same or fewer
waivers". Focus-visible ring styling is preserved via `--ring`.

## Testing

Per phase: `npm run typecheck`, `npm run lint`, `npm run test`; e2e after
phases 1, 2, and 3–4. Expected e2e churn: selectors driving the old custom
Select's `role=listbox` DOM and modal-dismissal timing.

## Risks

1. Radix Select portal markup breaks e2e selectors — dedicated test-update pass.
2. Tailwind v4 visual drift — accepted (pre-production).
3. `sonner` new runtime dep — small, self-hosted, tree-shaken.
4. Migration is large — phased so each phase leaves the app working; the e2e
   suite is the regression net, with the Phase 0 baseline as reference.

## Open decisions made during implementation (recorded)

- Palette is warm-paper + cobalt (D-037), not the neutral gray this spec's
  table originally assumed; mapping follows the real `tailwind.config.ts`.
- `canvas` navy and `status-*` families remain custom semantic tokens rather
  than being forced into shadcn slots that don't fit them.

## Implementation log (2026-08-30, all phases executed same day)

- **Phase 1**: `tailwindcss@4` + `@tailwindcss/postcss`, `autoprefixer` and
  `tailwind.config.ts` removed; tokens moved to `@theme` in `globals.css`;
  `theme()` call sites replaced with `var()` / `color-mix`.
- **Phase 2**: token sweep renamed legacy classes in 55 files via a one-shot
  script (since deleted); `next-themes` added (class strategy, system
  default); `ThemeToggle` (sun/moon) added to the topbar. `useEscape.ts`
  and `useClosing.ts` later deleted in Phase 3 (Radix subsumes both).
- **Phase 3**: `dialog.tsx`, `select.tsx` (Radix; public API byte-identical),
  `dropdown-menu.tsx`, `app-toaster.tsx` (sonner) created; all 11 hand-rolled
  modals, the custom Select, and the topbar `<details>` menus migrated;
  animation moved to `data-state` CSS (`.ui-overlay/.ui-content/.ui-menu`).
- **Phase 4**: `button/badge/banner` re-cut to cva (`card/avatar/divider/
  section-label` already conformed); `label.tsx`, `textarea.tsx`,
  `checkbox.tsx` added for API completeness (checkbox not yet adopted);
  `Textarea` re-exported from `input.tsx`; 8 files swept of stock
  `neutral/red/*` classes into the token vocabulary (zero remain company-wide).
- **E2E**: baseline at `8d7cd0d` + session animations = 54 passed / 10 failed
  (list in `e2e-baseline-2026-08-30.txt`). The 10 are auth-timeout flake and
  one pre-existing broken test (`phase3.spec.ts:215` expects a native
  `select[name=status]` the app has never rendered — needs a test rewrite,
  tracked as follow-up). A mid-migration re-run against an unchanged image
  confirmed the apparent new failures were flake, not regressions.
- **Three real issues found by e2e and fixed during final verification**:
  1. Sonner toasts render no `role="alert"` → the shared `appAlert` test
     helper now also matches `[data-sonner-toast][data-type="error"]`.
  2. Radix `DialogContent` wasn't viewport-scrollable → mobile clipped the
     signature modal's Type tab (`max-h-[calc(100dvh-2rem)] overflow-y-auto`).
  3. Dialog/menu entrance keyframes animated `transform`, which fought
     Tailwind v4's native `translate` property and Radix popper's inline
     `transform` — keyframes now animate the native `scale` property.
- **Pre-existing infra issue diagnosed**: the login rate limiter
  (`RL_LOGIN_PER_MIN`, default 10/min per IP) trips whenever the full suite
  runs in parallel from one source IP — this caused every full-suite failure
  across all runs, including at baseline. `.env.e2e` now raises the e2e
  values (production `.env` untouched). Final result: full suite green.
- `phase3.spec.ts:218` was rewritten to drive the Radix Select
  (combobox/option roles) instead of a native `<select>` that never existed.
- Dead dependency `@radix-ui/react-dialog` is now the Dialog primitive;
  `@radix-ui/react-checkbox` backs the new `checkbox.tsx`.
- New runtime dep: `sonner` (toasts). `.env.e2e` was created from the repo's
  example template for the isolated e2e stack.
