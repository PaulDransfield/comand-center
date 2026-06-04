-- M125 — recipe image thumbnails.
--
-- Adds recipes.image_url + a public Supabase Storage bucket the upload
-- endpoint writes to. Owners upload a dish photo; the recipe list +
-- editor + prep/order screens render a thumbnail via ProductThumb.
--
-- The bucket is PUBLIC so URLs work in <img src> without signing —
-- they're already business-tenanted by path (recipes/{business_id}/{file})
-- and the column linking them lives behind RLS-protected reads. No PII
-- risk: it's a dish photo, not financial data.

BEGIN;

ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS image_url TEXT;

COMMENT ON COLUMN recipes.image_url IS
  'Public Supabase Storage URL for the dish photo. NULL = no image. Set + cleared via /api/inventory/recipes/[id]/image.';

-- Create the bucket (idempotent).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'recipe-images',
  'recipe-images',
  TRUE,
  10 * 1024 * 1024,   -- 10 MB cap per upload
  ARRAY['image/jpeg','image/png','image/webp','image/gif']
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Public read so <img src> resolves without auth. Writes/deletes go
-- through our service-role API, never directly from the browser, so
-- we DON'T need a permissive insert/update policy here.
DROP POLICY IF EXISTS "recipe-images public read" ON storage.objects;
CREATE POLICY "recipe-images public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'recipe-images');

COMMIT;
