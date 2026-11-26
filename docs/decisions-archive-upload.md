# Archive upload — the permission decision (26.11.2026)

Rule 5 of `AGENTS.md`: who can do what is decided per stage and recorded here.
This records the request that introduced `/archive-upload` and migration 0043.

## Who may use `/archive-upload`

| Account | Access |
|---|---|
| Anonymous | Never. Sent to sign in. |
| `pending` with no window | Never. The no-access page says so. |
| `pending` with a window (`archive_upload_from` ≤ today ≤ `archive_upload_until`, Israel calendar, both ends inclusive) | Yes, for this screen only. |
| `pending` before or after the window | Never. The no-access page names the dates. |
| `volunteer` (content expert), `admin` | Always. |

Only administrators set, change or clear a window (`/manage/accounts`, pending
accounts only). The check constraint keeps both dates set or both empty, with
from ≤ until.

## What a window does **not** open

A window is not a role. The account stays `pending`, so every guard built on
`getCurrentVolunteer()` / `getCurrentAdmin()` still refuses it:
`/review`, `/review/bulk-upload`, `/review/corrections`, `/manage`, and every
other person's item. Whatever it uploads enters as `pending`, with no category
— never public until a content expert catalogues and approves it in the
workbench. The windowed account gets a receipt link per item, as any
contributor does.

## Where it is enforced (three places)

1. **Database:** `public.can_archive_upload()` (0043, `SECURITY DEFINER`,
   `authenticated` only). The columns are covered by the existing
   admin-only update policy on `profiles` (0007).
2. **Route:** `POST /api/items/archive-upload` calls `getArchiveUploader()`,
   which asks the database. The window columns are written only through
   `PATCH /api/manage/accounts/[id]` (admin).
3. **Render:** the proxy rewrites a refused visit to `/archive-upload/no-access`
   (403). The page checks again. The navigation shows the link only to experts
   (Archive menu) and to pending accounts whose window is open (main bar, after
   Contribute).

Until 0043 is applied, the function does not exist: experts and admins keep
access and every pending account is refused.

## AI

A `.txt` beside the media means the person has already described the item: no
AI reading is created for it. Without one, images and PDFs are `queued` for the
quiet-hours reader (0041). Videos are never read. Nothing calls Gemini while the
person waits.
