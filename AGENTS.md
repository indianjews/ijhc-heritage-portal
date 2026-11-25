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
