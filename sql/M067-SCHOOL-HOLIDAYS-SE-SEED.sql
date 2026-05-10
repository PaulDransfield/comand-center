-- M067 — Swedish school holidays seed (2025-2027)
--
-- Piece 3 Stream A: populate the M056 school_holidays table with manual
-- data for Sweden's largest kommuns. Skolverket doesn't publish a
-- machine-readable per-kommun calendar uniformly enough to scrape, so
-- we hand-curate the major regions and let the helper fall back to
-- län-level data for unspecified kommuns.
--
-- Coverage:
--   - Stockholm    (0180) — Vero + Chicce primary
--   - Göteborg     (1480)
--   - Malmö        (1280)
--   - Uppsala      (0380)
--
-- Holiday types (Sweden, restaurant-relevant):
--   - höstlov   (week 44, late Oct/early Nov)
--   - jullov    (~Dec 20 — Jan 7)
--   - sportlov  (varies by län; Stockholm = week 9)
--   - påsklov   (week of Easter, late Mar / early Apr)
--   - sommarlov (~Jun 13 — Aug 19)
--
-- Sources: each kommun's "läsårstider" page on stockholm.se / goteborg.se
-- / malmo.se / uppsala.se. Restaurant impact factor decisions documented
-- in the helper.
--
-- Idempotent (UNIQUE constraint + ON CONFLICT DO NOTHING).

INSERT INTO public.school_holidays (kommun, lan, start_date, end_date, name, source) VALUES
  -- ── Stockholm (kommun 0180, län 01) ─────────────────────────────────
  -- 2025-2026 academic year
  ('0180', '01', '2025-10-27', '2025-10-31', 'Höstlov',   'manual_seed_2026_05_10'),
  ('0180', '01', '2025-12-22', '2026-01-07', 'Jullov',    'manual_seed_2026_05_10'),
  ('0180', '01', '2026-02-23', '2026-03-01', 'Sportlov',  'manual_seed_2026_05_10'),
  ('0180', '01', '2026-03-30', '2026-04-06', 'Påsklov',   'manual_seed_2026_05_10'),
  ('0180', '01', '2026-06-15', '2026-08-17', 'Sommarlov', 'manual_seed_2026_05_10'),
  -- 2026-2027 academic year
  ('0180', '01', '2026-10-26', '2026-10-30', 'Höstlov',   'manual_seed_2026_05_10'),
  ('0180', '01', '2026-12-21', '2027-01-08', 'Jullov',    'manual_seed_2026_05_10'),
  ('0180', '01', '2027-02-22', '2027-02-28', 'Sportlov',  'manual_seed_2026_05_10'),
  ('0180', '01', '2027-04-05', '2027-04-12', 'Påsklov',   'manual_seed_2026_05_10'),
  ('0180', '01', '2027-06-14', '2027-08-16', 'Sommarlov', 'manual_seed_2026_05_10'),

  -- ── Göteborg (kommun 1480, län 14) ──────────────────────────────────
  ('1480', '14', '2025-10-27', '2025-10-31', 'Höstlov',   'manual_seed_2026_05_10'),
  ('1480', '14', '2025-12-22', '2026-01-07', 'Jullov',    'manual_seed_2026_05_10'),
  ('1480', '14', '2026-02-16', '2026-02-22', 'Sportlov',  'manual_seed_2026_05_10'),  -- VG län week 8
  ('1480', '14', '2026-03-30', '2026-04-06', 'Påsklov',   'manual_seed_2026_05_10'),
  ('1480', '14', '2026-06-15', '2026-08-17', 'Sommarlov', 'manual_seed_2026_05_10'),
  ('1480', '14', '2026-10-26', '2026-10-30', 'Höstlov',   'manual_seed_2026_05_10'),
  ('1480', '14', '2026-12-21', '2027-01-08', 'Jullov',    'manual_seed_2026_05_10'),
  ('1480', '14', '2027-02-15', '2027-02-21', 'Sportlov',  'manual_seed_2026_05_10'),
  ('1480', '14', '2027-04-05', '2027-04-12', 'Påsklov',   'manual_seed_2026_05_10'),
  ('1480', '14', '2027-06-14', '2027-08-16', 'Sommarlov', 'manual_seed_2026_05_10'),

  -- ── Malmö (kommun 1280, län 12) ─────────────────────────────────────
  ('1280', '12', '2025-10-27', '2025-10-31', 'Höstlov',   'manual_seed_2026_05_10'),
  ('1280', '12', '2025-12-22', '2026-01-07', 'Jullov',    'manual_seed_2026_05_10'),
  ('1280', '12', '2026-02-09', '2026-02-15', 'Sportlov',  'manual_seed_2026_05_10'),  -- Skåne län week 7
  ('1280', '12', '2026-03-30', '2026-04-06', 'Påsklov',   'manual_seed_2026_05_10'),
  ('1280', '12', '2026-06-15', '2026-08-17', 'Sommarlov', 'manual_seed_2026_05_10'),
  ('1280', '12', '2026-10-26', '2026-10-30', 'Höstlov',   'manual_seed_2026_05_10'),
  ('1280', '12', '2026-12-21', '2027-01-08', 'Jullov',    'manual_seed_2026_05_10'),
  ('1280', '12', '2027-02-08', '2027-02-14', 'Sportlov',  'manual_seed_2026_05_10'),
  ('1280', '12', '2027-04-05', '2027-04-12', 'Påsklov',   'manual_seed_2026_05_10'),
  ('1280', '12', '2027-06-14', '2027-08-16', 'Sommarlov', 'manual_seed_2026_05_10'),

  -- ── Uppsala (kommun 0380, län 03) ───────────────────────────────────
  ('0380', '03', '2025-10-27', '2025-10-31', 'Höstlov',   'manual_seed_2026_05_10'),
  ('0380', '03', '2025-12-22', '2026-01-07', 'Jullov',    'manual_seed_2026_05_10'),
  ('0380', '03', '2026-02-23', '2026-03-01', 'Sportlov',  'manual_seed_2026_05_10'),  -- Uppsala län week 9
  ('0380', '03', '2026-03-30', '2026-04-06', 'Påsklov',   'manual_seed_2026_05_10'),
  ('0380', '03', '2026-06-15', '2026-08-17', 'Sommarlov', 'manual_seed_2026_05_10'),
  ('0380', '03', '2026-10-26', '2026-10-30', 'Höstlov',   'manual_seed_2026_05_10'),
  ('0380', '03', '2026-12-21', '2027-01-08', 'Jullov',    'manual_seed_2026_05_10'),
  ('0380', '03', '2027-02-22', '2027-02-28', 'Sportlov',  'manual_seed_2026_05_10'),
  ('0380', '03', '2027-04-05', '2027-04-12', 'Påsklov',   'manual_seed_2026_05_10'),
  ('0380', '03', '2027-06-14', '2027-08-16', 'Sommarlov', 'manual_seed_2026_05_10')
ON CONFLICT (kommun, start_date, name) DO NOTHING;

-- Verification
SELECT kommun, COUNT(*) AS holidays
FROM public.school_holidays
GROUP BY kommun
ORDER BY kommun;
