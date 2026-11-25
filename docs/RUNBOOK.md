# Runbook — IJHC Heritage Portal

For whoever is holding this at 02:00. No context assumed.

| | |
|---|---|
| Live site | https://archive.indianjews.org |
| Hosting | Vercel, project `ijhc-heritage-portal`, team `indianjews` (deploys every push to `master`; it is the cron home, `CRON_HOME=1`) |
| Legacy (deprecated) | `heritage-portal-snowy.vercel.app` — the original developer's personal deployment. Not production; do not deploy to it or diagnose from it |
| Database + files | Supabase project `llfwnitakmhuyexvqvft` (`ijhc-heritage-portal`), eu-central-1 |
| Code | `heritage-portal/` in this repository. `../project/` is the old demo — **never deploy it** |
| Secrets | `.env.local`, not in git. Vercel holds its own copy in project settings |

---

## Is it actually broken?

Run these before changing anything. All four should answer as shown.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://archive.indianjews.org/
curl -s -o /dev/null -w '%{http_code}\n' https://archive.indianjews.org/portal
curl -s https://archive.indianjews.org/portal | grep -oE 'href="/portal/[0-9a-f-]{36}"' | sort -u | wc -l
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://archive.indianjews.org/api/analyze -H 'content-type: application/json' -d '{"path":"x"}'
```

Expected: `200`, `200`, `9` or more, `400`. A `500` on the first two, or
anything other than `400` on the last, is a real fault.

The third check counts links to record pages rather than grepping for the
"records published" line. React splits that line across text nodes in the
server-rendered HTML, so a grep for it matches nothing however the site is
behaving — a check that always fails is worse than no check. Counting links
also measures the thing that matters: records a visitor can actually open.

**Most likely cause, in order:** an expired or rotated Supabase key; Gemini
returning 503 (this is common and only breaks the analysis step, not the site);
Supabase paused for inactivity on the free plan.

---

## Roll the code back

The safest action and almost always the right first one. It does not touch data.

```bash
npx vercel rollback --yes --scope indianjews
```

That promotes the previous production deployment. To pick a specific one:

```bash
npx vercel ls ijhc-heritage-portal --scope indianjews
npx vercel promote <deployment-url> --scope indianjews
```

**Verify after:** re-run the four checks above. The site should serve the
previous build within about a minute.

### If you need to rebuild from source instead

```bash
cd heritage-portal
git log --oneline -10            # find the commit you want
git checkout <sha>
npm ci                           # the lockfile is the pinned set — do not npm install
npm run verify                   # typecheck + lint + tests + build, all must pass
npx vercel link --yes --scope indianjews --project ijhc-heritage-portal   # once per checkout
npx vercel --prod --yes --scope indianjews
```

---

## Roll the database back

**A code rollback does not undo a migration.** Migrations are in
`supabase/migrations/`, applied in order. The recent ones and what undoes each:

| Migration | What it did | To undo |
|---|---|---|
| 0041 | `queued` added to the `analysis_status` enum (bulk upload). Not wrapped in a transaction (ALTER TYPE ADD VALUE). **Not applied automatically** — until it is, `/api/items/bulk-upload-item` answers 503 `migration_required` and saves nothing | An enum value cannot be dropped. Retire it with `update public.ai_analyses set status = 'failed', error = 'Queued reading cancelled.' where status = 'queued';` — then it is unused |
| 0040 | `item_files.backed_up_at` (nullable) + partial index `item_files_not_backed_up` on `created_at` where it is NULL. **Not applied automatically** — run it in the SQL editor before the code; until then the Drive file phase answers `filePhase: "unavailable"` and the table backup still runs | `begin; drop index if exists public.item_files_not_backed_up; alter table public.item_files drop column if exists backed_up_at; commit;` — only loses the "already copied" marks; later runs re-upload every file |
| 0037 | collector credit columns, `keyword_candidates.source/item_id`, `record_comments` (+ public view), `record_corrections` | Drop the two tables and the view; the columns are safe to leave. Code from 20.10 needs them |
| 0036 | `items.uploaded_by`, `can_edit_published`, owner rule on items/item_fields/item_families/item_translations policies, `review_drafts`, `similar_review_terms` | Restore the previous policy bodies from 0007/0012/0023 (`is_volunteer()`), drop `review_drafts`. Code from 20.10 needs them |
| 0035 | `ai_analyses.retry_count`, `last_retry_at`, `claim_reading_retry()` | Drop the function; columns safe to leave |
| 0034 | `item_duplicates`, `item_contributors`, duplicate functions, restore trigger on `items` | Drop trigger `restore_duplicate_files` first, then functions and tables |
| 0022 | `items.contributor_id` → `ON DELETE SET NULL` | Re-add the constraint without `on delete set null`. Safe to leave in place |
| 0021 | Vocabulary gained `branch_key`, `preferred_id`, `external_id` + a trigger | Columns are additive. `drop trigger keywords_variant_flat on keywords;` disables the variant rule without data loss |
| 0020 | `contributors` + `contributor_families` created; `items.contributor_key` dropped | **Not reversible without the backup.** `contributor_key` held HMACs that cannot be recomputed for deleted rows |
| 0018/0019 | The bin: `deleted_at`, `deleted_by`, `deleted_reason` | Additive. Clearing `deleted_at` on every row restores the pre-bin behaviour |
| 0017 | `items.contributor_email` dropped, moved to a table | **Not reversible without the backup** |
| 0015 | Published-record policies widened to `authenticated` | `alter policy items_public_select on items to anon;` and the two siblings |

**0017 and 0020 dropped columns. Those are the ones the backup exists for.**

## Restore data

```bash
cd heritage-portal
ls backups/                            # newest directory is the most recent run
npx tsx scripts/backup.ts --verify     # confirms the newest run is readable and complete
```

Each `backups/<timestamp>/` holds one JSON file per table and a `files/`
directory with every stored object, its storage path flattened with `__` in
place of `/`. `manifest.json` holds the expected row and byte counts.

Restoring is deliberately manual — there is no one-command restore, because a
restore is never routine and should be done by someone reading the data first.
Load a table with the service-role key and the JSON for that table, in the
order they appear in `TABLES` in `scripts/backup.ts` (parents before children).

**Take a fresh backup before restoring anything.** A restore over live data is
itself destructive.

### The quiet-hours AI queue (`/api/cron/process-pending-ai`, 23:30 UTC)

Items from `/review/bulk-upload` are saved without calling the model; each
image's and PDF's `ai_analyses` row is `queued`. This cron reads a few of them each
night. Only on the deployment with `CRON_HOME=1`, only with `CRON_SECRET`.

It answers with one of:

| Answer | Meaning | What to do |
|---|---|---|
| `attempted: N` | read N queued images or PDFs (each one model call) | nothing |
| `skipped: "busy"` | ≥ `AI_QUEUE_BUSY_THRESHOLD` (default 2) live readings in the last 20 minutes — people come first | nothing; tomorrow's run tries again |
| `skipped: "quota_reserve"` | today's usage (US Pacific day, counted from `ai_analyses` like `npm run quota`) plus this run would eat into `AI_QUEUE_RESERVE` (default 8) of `AI_DAILY_BUDGET` (default 20) | nothing, or raise `AI_DAILY_BUDGET` once billing is on |
| `skipped: "disabled"` | `AI_QUEUE_PER_RUN=0` | — |

`remainingPending` is how many queued readings are left. At the default four
a night, 40 queued files take ten nights; raise `AI_QUEUE_PER_RUN` (max 10)
or run the cron by hand at a quiet hour:

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" https://archive.indianjews.org/api/cron/process-pending-ai
```

- A claimed reading becomes `pending` with `last_retry_at` as its lease. A run
  that dies mid-read leaves it `pending`; after two hours the ordinary retry
  (`/api/cron/reread`) reads it as abandoned. A failed queued reading is an
  ordinary failed reading from then on (retry button, nightly retry).
- Video files are never sent to the model and get no reading. A record with a
  video file or a YouTube link is read from its images/PDFs and the expert's
  notes, with an `<attached-media>` note telling the model the recording
  exists and must not be described.
- A YouTube-only item (no image) has nothing to read; it waits for an expert.

### The nightly off-site copy (`/api/cron/backup`, 21:45 UTC)

It runs only on the deployment with `CRON_HOME=1` and only with the
`CRON_SECRET` bearer token. Where it writes depends on the environment:

| Set | Destination | What it writes |
|---|---|---|
| `BACKUP_GDRIVE_WEBHOOK_URL` + `BACKUP_GDRIVE_SECRET` | private Google Drive folder, via the Apps Script bridge (wins over S3) | `<date>/tables/<table>.json` for every table, then `<date>/manifest.json`; media files once each under `files/<storage path>` (needs migration 0040) |
| `BACKUP_S3_*` | S3-compatible bucket | `<prefix>/<date>/database.json.gz`, plus `<prefix>/files/<path>` once per file |
| neither | nothing | answers `configured: false` |
| only one of the two Drive variables, or a URL that is not `https://script.google.com/macros/s/…/exec`, or a secret under 32 characters | nothing | answers **500 `backup_misconfigured`** and logs a problem |

Every table is counted with `count: 'exact'` before it is read in 1000-row
pages. A table that reads short is listed under `database.short` and logged.

**Drive specifics.**
- `manifest.json` is written last, and only when every table uploaded and
  none read short. **A dated folder without `manifest.json` is an incomplete
  run — do not restore from it.**
- After a complete run the oldest run folders (named `YYYY-MM-DD`) beyond the
  newest 14 are trashed (Drive's bin, recoverable for 30 days). Other folders
  in the backup folder are never touched. A failed run never prunes.
- **Media files** (images, PDFs, audio, video from the `heritage` bucket) go
  to a permanent `files/` folder that mirrors the bucket
  (`uploads/2026/08/<uuid>-scan.jpg` → `files/uploads/2026/08/<uuid>-scan.jpg`).
  It is never inside a dated folder, so pruning never reaches it; restore a
  file from `files/` + its `storage_path`.
- Files go **incrementally**: `item_files.backed_up_at` is set only after the
  bridge confirms the upload. Each run takes the oldest unmarked files, at
  most 20, with whatever budget the tables left, and starts no file with
  under 8 s left (under 20 s for one over 8 MB). A failed file stays NULL
  and is retried on a later night. Only masters are copied, not
  `preview_path` renditions, which can be rebuilt from them.
- **Size limit: 25 MB per file.** An Apps Script Web App takes a request body
  of about 50 MB, and base64 adds a third. Larger files are never
  downloaded; they are listed under `filesSkippedOversize`, and one problem
  per run names them. Back those up with `scripts/backup.ts` or the S3
  destination. They stay in `filesRemaining`, so that number does not reach
  0 while any exist.
- File-phase fields in the response: `filesBackedUp`, `filesFailed`,
  `filesSkippedOversize`, `filesRemaining` (exact count of files with no
  off-site copy yet), and `filePhase`: `done`, `budget` (time ran out;
  tomorrow continues), or `unavailable` (migration 0040 not applied).
- At 20 files a night the first pass over an existing bucket takes
  (number of files ÷ 20) nights. Run the cron by hand (below) to speed it up;
  each call continues where the last stopped.
- **Re-uploads:** a file whose upload timed out on our side may still have
  reached Drive. It is not marked, so it is sent again on a later night.
  Whether that replaces or duplicates the Drive copy depends on the Apps
  Script's `upload` (it should replace a file of the same name in the same
  folder).
- A failed upload is logged in `/manage/problems` with the bridge's reason.
  The secret and the deployment id are redacted from every message.
- The response's `stopped: "budget"` means the 45-second budget ran out
  before every table was sent; tomorrow's run starts again from the first
  table.

Check it by hand (from a machine with the secret, never in a chat):

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" https://archive.indianjews.org/api/cron/backup
```

**Rotating the bridge secret:** set the new value in the Apps Script's
properties and in Vercel's `BACKUP_GDRIVE_SECRET` together, then redeploy;
one run fails in between if they disagree.

---

## Rollback triggers

Roll back if any of these is true:

| Trigger | Measured how |
|---|---|
| `/` or `/portal` returns 5xx | the checks above |
| The portal shows fewer published records than the day before | the third check above |
| Any file on a published record 404s or 403s | open a record page, check the image loads |
| A contributor's upload fails at submit | the browser console on `/upload` |
| The review screen is reachable without signing in | `curl -o /dev/null -w '%{http_code}' …/review` must be `307` |

Gemini returning 503 is **not** a rollback trigger. It breaks the analysis step
only; contribution still works and the archive still serves.

---

## Who to call

Inon. There is no on-call rota and no second maintainer — which is itself worth
fixing and is recorded in the go-live report.

---

## What has no rollback

- **Purging a record from the bin** destroys the row and its file in storage.
  Only the backup brings it back, and only as far as the last run.
- **Erasing a contributor** is permanent. Their records survive and are
  unlinked; the person's name and address are gone.
- **Removing a vocabulary term** leaves the word on records already catalogued
  but makes it unchoosable, so the next review saved on one of those records
  drops it.

Each of these asks for confirmation and names what will be lost before it acts.
