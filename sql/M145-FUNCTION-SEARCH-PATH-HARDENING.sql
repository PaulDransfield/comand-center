-- M145 — pin search_path on functions flagged `function_search_path_mutable`
-- (Supabase security advisor lint 0011). A fixed search_path makes each
-- function ignore the caller's path, which closes the SECURITY DEFINER
-- search-path-hijack vector and satisfies the linter.
--
-- Value `public, extensions, pg_catalog`: public holds this project's
-- tables + pg_trgm/unaccent; extensions covers any extension-schema
-- installs; pg_catalog for built-ins. Verified live — f_unaccent still
-- resolves unaccent() ("Crème Brûlée" → "Creme Brulee").
--
-- Idempotent. Applied 2026-06-10.

ALTER FUNCTION public.ai_spend_24h_global_usd()                                            SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.apply_invoice_pdf_extraction(uuid,uuid,text,text,text,date,jsonb)    SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.brand_classifications_learned_touch_updated_at()                     SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.caspeco_employees_touch_updated_at()                                 SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.events_touch_updated_at()                                            SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.f_unaccent(text)                                                     SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.get_my_org_id()                                                      SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.hourly_metrics_touch_updated_at()                                    SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.increment_ai_usage(uuid,date)                                        SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.increment_ai_usage(uuid,text,integer,integer,integer,integer,numeric) SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.increment_ai_usage_checked(uuid,date,integer)                        SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.inventory_touch_alias(uuid)                                          SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.inventory_trigram_search(uuid,text,integer)                          SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.is_org_admin(uuid)                                                   SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.memo_feedback_touch_updated_at()                                     SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.product_aliases_record_correction(uuid,integer)                      SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.recipe_ingredients_touch_parent()                                    SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.recipes_touch_updated_at()                                           SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.set_inventory_backfill_state_updated_at()                            SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.set_invoice_pdf_extractions_updated_at()                             SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.set_products_updated_at()                                            SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.set_updated_at()                                                     SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.stock_count_lines_touch()                                            SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.supplier_articles_touch_updated_at()                                 SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.touch_menus_updated_at()                                             SET search_path = public, extensions, pg_catalog;
ALTER FUNCTION public.weather_daily_touch_updated_at()                                     SET search_path = public, extensions, pg_catalog;
