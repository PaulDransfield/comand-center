-- M148 — drop the broad PUBLIC SELECT (listing) policies on the two public
-- image buckets (advisor lint 0025 public_bucket_allows_listing).
--
-- Both buckets are public=true, so object reads happen via the public CDN
-- path (/storage/v1/object/public/...), which does NOT consult storage.objects
-- RLS. The SELECT policy only let anon/authenticated LIST/read via the
-- authenticated Storage API — which the app never does (verified: recipe-images
-- is server-side upload/getPublicUrl/remove only; supplier-article-images is
-- served from stored public URLs; all server storage ops use service_role,
-- which bypasses RLS). Dropping them stops bucket enumeration without
-- affecting image display or uploads.
--
-- Verified live: both buckets still public=true, 0 leftover listing policies.
-- Applied 2026-06-10.
DROP POLICY IF EXISTS "recipe-images public read"            ON storage.objects;
DROP POLICY IF EXISTS "Public read supplier-article-images"  ON storage.objects;
