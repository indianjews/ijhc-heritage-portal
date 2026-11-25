-- When each file's bytes were last copied off-site by /api/cron/backup (the
-- Google Drive destination). NULL = not yet copied. Set by the cron only,
-- through the service role, and only after the bridge confirmed the upload.
--
-- Not applied automatically. Apply in the Supabase SQL editor BEFORE pushing
-- the code that reads it; until then the cron's file phase reports
-- `filePhase: "unavailable"` and the table backup still runs.
--
-- No RLS or grant changes: item_files has row policies only (0002, 0015,
-- 0018), so existing select('*') reads keep working and simply gain the column.
--
-- Undo:
--   begin;
--   drop index if exists public.item_files_not_backed_up;
--   alter table public.item_files drop column if exists backed_up_at;
--   commit;
-- (Dropping the column only loses the "already copied" marks; the next runs
-- re-upload every file.)

begin;

alter table public.item_files
  add column if not exists backed_up_at timestamptz default null;

-- The cron asks for the oldest not-yet-copied files, a few at a time.
create index if not exists item_files_not_backed_up
  on public.item_files (created_at)
  where backed_up_at is null;

commit;
