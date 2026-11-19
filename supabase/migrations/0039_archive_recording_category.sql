-- Add archive_recording as a valid item category.
-- The category column uses a PostgreSQL enum type (item_category), not a check
-- constraint. Apply this in the Supabase SQL editor BEFORE pushing the code.
--
-- Undo: enum values cannot be removed in Postgres. To roll back, rename it:
--   ALTER TYPE item_category RENAME VALUE 'archive_recording' TO '_removed';
-- (any rows with that value must be updated/deleted first)

ALTER TYPE item_category ADD VALUE 'archive_recording';
