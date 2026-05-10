-- M068 — Add Örebro (kommun 1880) to school_holidays seed
--
-- Chicce Slotsgatan is in Örebro. M067 covered Sweden's biggest 4 kommuns
-- (Stockholm/Göteborg/Malmö/Uppsala); this extends coverage to Örebro
-- so the dailyForecast() school_holiday signal engages for Chicce too.
--
-- Örebro län (län 18) — sportlov is week 8 (Feb 16-22 in 2026).
-- Other holidays follow the standard Swedish pattern.
--
-- Idempotent (UNIQUE on kommun, start_date, name).

INSERT INTO public.school_holidays (kommun, lan, start_date, end_date, name, source) VALUES
  -- 2025-2026 academic year
  ('1880', '18', '2025-10-27', '2025-10-31', 'Höstlov',   'manual_seed_2026_05_10'),
  ('1880', '18', '2025-12-22', '2026-01-07', 'Jullov',    'manual_seed_2026_05_10'),
  ('1880', '18', '2026-02-16', '2026-02-22', 'Sportlov',  'manual_seed_2026_05_10'),  -- Örebro län week 8
  ('1880', '18', '2026-03-30', '2026-04-06', 'Påsklov',   'manual_seed_2026_05_10'),
  ('1880', '18', '2026-06-15', '2026-08-17', 'Sommarlov', 'manual_seed_2026_05_10'),
  -- 2026-2027 academic year
  ('1880', '18', '2026-10-26', '2026-10-30', 'Höstlov',   'manual_seed_2026_05_10'),
  ('1880', '18', '2026-12-21', '2027-01-08', 'Jullov',    'manual_seed_2026_05_10'),
  ('1880', '18', '2027-02-15', '2027-02-21', 'Sportlov',  'manual_seed_2026_05_10'),
  ('1880', '18', '2027-04-05', '2027-04-12', 'Påsklov',   'manual_seed_2026_05_10'),
  ('1880', '18', '2027-06-14', '2027-08-16', 'Sommarlov', 'manual_seed_2026_05_10')
ON CONFLICT (kommun, start_date, name) DO NOTHING;

-- Set Chicce Slotsgatan's kommun
UPDATE public.businesses
SET kommun = '1880'
WHERE id = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
  AND kommun IS NULL;

-- Verify
SELECT kommun, COUNT(*) AS holidays
FROM public.school_holidays
GROUP BY kommun
ORDER BY kommun;

SELECT id, name, kommun
FROM public.businesses
WHERE name ILIKE '%chicce%';
