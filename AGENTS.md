<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

---

# IJHC Heritage Portal — project rules

The map of the code (structure, data model, request paths, deliberate oddities) is
`docs/CODEBASE-GUIDE.md`. The handoff for people, in Hebrew, is
`docs/HANDOFF-העברת-מקל.md`. Read the guide before changing anything.

## Context

Stage 1 of a digital archive for the Indian Jewish Heritage Center. The sibling
folder `../project/` holds the original Bolt demo. It is **reference only** —
never edit it, never deploy it, never share its database.

## Rules that are not negotiable

1. **AI output never lands in `items`.** It goes to `ai_analyses`. A human moves
   it across in the review workbench. The public portal reads `items` only.

2. **Never invent technical metadata.** Size, dimensions, duration are measured
   from the file. If a value cannot be determined, it is `null` and the UI says
   "not measured". The demo generated GPS coordinates with `Math.random()` and
   displayed them as EXIF; do not reintroduce anything like it.

3. **No React component talks to Supabase directly.** Reads go through
   `src/lib/items/queries.ts`, writes through `src/lib/items/mutations.ts`.

4. **Permission is enforced in three places** — RLS, the route handler, and the
   render. Adding a screen means updating all three.

5. **Ask before changing who can do what.** The permission model is decided per
   stage, not inherited. The current roles and rules are summarised in
   `docs/CODEBASE-GUIDE.md` (§2 and §4); record any new decision in `docs/`.

6. **`SUPABASE_SERVICE_ROLE_KEY` and `GEMINI_API_KEY` are server-only.** Never
   prefix either with `NEXT_PUBLIC_`.

## Accessibility (WCAG 2.0 AA / Israeli SI 5568)

The law requires it, and the public statement at `/accessibility` promises it.
Every PR keeps it true; a screen that breaks one of these is not finished.

- **Structure.** The root layout owns the landmarks: one `<header>`, one
  `<main id="main-content">`, one `<footer>`. A page never adds another
  `<main>`. Each page has exactly one `<h1>` (visually hidden with `sr-only` if
  the design has no visible title) and headings never skip a level. Several
  `<nav>`s on one page each get a distinct `aria-label`.
- **Keyboard.** Everything works with `Tab`, `Shift+Tab`, `Enter`, `Space` and
  `Escape`. Interactive things are `<button>` or `<a>`/`<Link>`, never a
  clickable `<div>`/`<span>`. No keyboard traps. Closing a menu, panel or
  dialog (including with `Escape`) and finishing an inline edit put focus back
  on the control that opened it. Do not claim an ARIA pattern you do not
  implement: no `role="menu"` or `role="tab"` without their arrow-key
  behaviour — use a disclosure (`aria-expanded` + `aria-controls`) or pressed
  buttons (`aria-pressed`) in a named `role="group"` instead.
- **Focus.** Never remove the global `:focus-visible` ring (`outline-none`,
  `focus:outline-none` are banned on controls). The only exception is a
  non-interactive `tabIndex={-1}` target such as `<main>`.
- **Names.** Every input, select and textarea has a `<label>` (or
  `aria-label`/`aria-labelledby`); placeholders are hints, never labels. Every
  icon-only button or link has an `aria-label`. Informative images have
  meaningful `alt` (an item's title at least); decorative images use `alt=""`
  and decorative icons/SVGs `aria-hidden="true"` (lucide icons do this by
  default — do not undo it). `<audio>`, `<video>` and `<iframe>` are named.
- **Contrast** (light mode only). Text ≥ 4.5:1, large text ≥ 3:1, and UI
  boundaries (form-field edges, focus ring) ≥ 3:1 — against every ground they
  sit on, including `surface-2`. Use the tokens in `globals.css`
  (`border-control` for field edges); measure any new colour before using it.
- **Announcements.** Form errors use `role="alert"`; async progress and
  "saved/sent" messages use `role="status"`/`aria-live="polite"`. A field in
  error gets `aria-invalid` and `aria-describedby` pointing at its message.
- **Language and direction.** `lang` and `dir` are set on `<html>` by the root
  layout from the reader's language (`he` → `rtl`). Use logical CSS
  (`ms-`/`me-`, `ps-`/`pe-`, `start`/`end`, `text-start`), `dir="auto"` on
  user-typed text, and `dir="ltr"` (or `<bdi>`) for URLs, phone numbers and
  codes inside Hebrew.
- **No overlays.** Never add a third-party accessibility widget or overlay;
  fix the code.
- **Tests.** New screens get a render test covering their names, roles and
  error announcements (see `tests/unit/accessibility.test.tsx`). Update
  `/accessibility` (`src/lib/legal.ts`, both languages, review date) when a
  change alters what it says.

## Before saying a feature is done

```bash
npm run verify
```

It must pass. Then update the documentation in `docs/` that the change affects
(at least `docs/CODEBASE-GUIDE.md` when the map, data model, request paths or
permissions change, and `docs/RUNBOOK.md` for any migration and how to undo it).

## Next 16 notes

- The request-interception file is `src/proxy.ts`, exporting `proxy`. The
  `middleware` convention is deprecated in this version.
- `params` and `searchParams` are Promises and must be awaited.
- `cookies()` from `next/headers` is async.
