-- Add archive_recording as a valid item category.
-- Apply this in the Supabase SQL editor BEFORE pushing the code that uses it.
-- Undo: drop the new constraint and re-add the original three-value one.

BEGIN;

ALTER TABLE items DROP CONSTRAINT IF EXISTS items_category_check;

ALTER TABLE items ADD CONSTRAINT items_category_check
  CHECK (category IN ('material_culture', 'documents', 'oral_histories', 'archive_recording'));

COMMIT;
