-- A temporary "archive upload" window for a registered (pending) account.
--
-- Decision (26.11.2026, recorded in docs/decisions-archive-upload.md): content
-- experts and administrators may always use /archive-upload. A registered
-- account that has not been approved (role `pending`) may use it ONLY between
-- two dates an administrator sets, inclusive, by the Israel calendar. The
-- window grants nothing else: /review, /manage and every other expert route
-- keep gating on is_volunteer(), which is false for `pending` whatever the
-- dates say. Everything uploaded this way enters as `pending` for review.
--
-- Who can set the dates: only administrators. `profiles` has exactly one
-- UPDATE policy, profiles_admin_update (0007, is_admin()), and no self-update
-- path, so the new columns inherit it; nothing to add.
--
-- can_archive_upload() is the single answer the app asks — from the upload
-- route, the proxy and the page — so the rule lives in the database once.
--
-- Apply in the Supabase SQL editor BEFORE pushing the code. Until then
-- /archive-upload still works for experts and administrators (their access
-- does not depend on the columns) and refuses everyone else.
--
-- Undo:
--   begin;
--   drop function if exists public.can_archive_upload();
--   alter table public.profiles drop constraint if exists profiles_archive_upload_window;
--   alter table public.profiles drop column if exists archive_upload_until;
--   alter table public.profiles drop column if exists archive_upload_from;
--   commit;
-- (Drops every window that was granted; items already uploaded are unaffected.)

begin;

alter table public.profiles
  add column if not exists archive_upload_from date,
  add column if not exists archive_upload_until date;

alter table public.profiles
  add constraint profiles_archive_upload_window check (
    (archive_upload_from is null and archive_upload_until is null)
    or (archive_upload_from is not null and archive_upload_until is not null
        and archive_upload_from <= archive_upload_until)
  );

-- The caller's own access, now. SECURITY DEFINER so it reads the caller's own
-- profile row regardless of which select policy applies; it takes no
-- argument, so it can never answer for anyone else.
create or replace function public.can_archive_upload()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles p
    where p.id = auth.uid()
      and (
        p.role in ('volunteer', 'admin')
        or (
          p.role = 'pending'
          and p.archive_upload_from is not null
          and (now() at time zone 'Asia/Jerusalem')::date
              between p.archive_upload_from and p.archive_upload_until
        )
      )
  );
$$;
revoke all on function public.can_archive_upload() from public, anon;
grant execute on function public.can_archive_upload() to authenticated;

commit;
