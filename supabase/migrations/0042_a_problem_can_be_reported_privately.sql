-- A private "report a problem" on a published record.
--
-- Comments (record_comments) are public the moment they are sent, and
-- corrections (record_corrections) must carry a field change. Neither fits
-- "this was uploaded by mistake" or "this shows a living person", which must
-- reach a content expert and nobody else. Reusing either table would mean a
-- hidden-at-birth comment indistinguishable from moderated spam, or a
-- correction with an invented change, so this is its own table.
--
-- Who can do what:
--   anyone      submits, only through POST /api/records/[id]/feedback (service
--               role, rate limited, honeypot) — no grant to anon at all
--   experts     read every report; move an open one to resolved/dismissed,
--               stamped with their own id (is_volunteer(), as for corrections)
--   public      nothing: no select grant, no view, never on the record page
--
-- No existing table, policy or function is changed.
--
-- Apply in the Supabase SQL editor BEFORE pushing the code. Until then the
-- report form answers with the ordinary "could not be sent" message and
-- nothing else is affected.
--
-- Undo (destroys any reports already received — export them first):
--   begin;
--   drop table if exists public.record_reports;
--   commit;

begin;

create table public.record_reports (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id) on delete cascade,
  reason text not null check (reason in ('mistake', 'living_person', 'rights', 'offensive', 'other')),
  body text check (char_length(body) <= 2000),
  reporter_name text check (char_length(reporter_name) <= 120),
  reporter_email text check (char_length(reporter_email) <= 254),
  anonymous boolean not null default false,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  decided_at timestamptz,
  decided_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint record_reports_decision_recorded check (
    (status = 'open' and decided_at is null and decided_by is null)
    or (status <> 'open' and decided_at is not null)
  ),
  constraint record_reports_other_explained check (reason <> 'other' or nullif(btrim(body), '') is not null)
);
create index record_reports_open on public.record_reports(created_at) where status = 'open';

alter table public.record_reports enable row level security;
create policy reports_expert_read on public.record_reports
  for select to authenticated using (public.is_volunteer());
-- USING sees the old row (must still be open); WITH CHECK the new one.
create policy reports_expert_decide on public.record_reports
  for update to authenticated
  using (public.is_volunteer() and status = 'open')
  with check (public.is_volunteer() and status in ('resolved', 'dismissed') and decided_by = auth.uid());

revoke all on public.record_reports from anon, authenticated;
grant select on public.record_reports to authenticated;
grant update (status, decided_at, decided_by) on public.record_reports to authenticated;
grant all on public.record_reports to service_role;

commit;
