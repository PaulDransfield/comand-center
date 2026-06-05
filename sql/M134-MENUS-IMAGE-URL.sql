-- sql/M134-MENUS-IMAGE-URL.sql
--
-- Add image_url to menus so a set menu can carry a hero photo, parallel
-- to recipes.image_url. Owner asked 2026-06-05 — the menu list should
-- show cards like the recipe list does.

ALTER TABLE menus
  ADD COLUMN IF NOT EXISTS image_url text;
