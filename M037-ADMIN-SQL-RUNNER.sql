-- M037-ADMIN-SQL-RUNNER.sql
-- ============================================================================
-- Admin v2 Tools tab — server-side SQL runner with read-only enforcement.
--
-- Why an RPC instead of just running the query through the JS Supabase client:
--   - PostgREST does not allow arbitrary SQL. The closest you get is a
--     stored function with a fixed signature.
--   - We want defence-in-depth on the read-only guarantee. JS-side regex
--     validation is the primary check; this RPC re-applies the same
--     regex AND wraps the query in a SELECT subquery, so the only thing
--     it can ever produce is a row-set.
--   - statement_timeout + lock_timeout are set inside the function so a
--     run-away query cannot wedge a Supabase connection.
--
-- Security model:
--   - SECURITY DEFINER (so it can read every public table regardless of
--     the caller's role).
--   - EXECUTE granted only to service_role. The Admin v2 Tools route
--     calls it via the service-role client; no anon/authenticated path.
--   - Even if a future code path accidentally exposed it, the regex
--     check rejects every write keyword and the SELECT wrapper means
--     the only valid queries are read-only.
--
-- What it does NOT do:
--   - Pretty-print column order (JSONB normalises key order). The page
--     extracts columns from Object.keys(rows[0]) which gives JSONB's
--     length-then-bytewise order. Good enough for ad-hoc exploration.
--   - Stream large results — bounded by p_limit (capped 1000).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION admin_run_sql(
  p_query TEXT,
  p_limit INTEGER DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_query    TEXT;
  v_upper    TEXT;
  v_limit    INTEGER;
  v_rows     JSONB;
  v_count    INTEGER;
  v_started  TIMESTAMPTZ := clock_timestamp();
  v_duration NUMERIC;
BEGIN
  -- Normalise: trim whitespace and a single trailing semicolon.
  v_query := regexp_replace(btrim(p_query), ';\s*$', '');

  IF v_query IS NULL OR length(v_query) = 0 THEN
    RAISE EXCEPTION 'Query is empty';
  END IF;

  -- Reject any embedded semicolon (multi-statement guard).
  IF v_query ~ ';' THEN
    RAISE EXCEPTION 'Multi-statement queries are not allowed';
  END IF;

  -- Must start with SELECT or WITH (after stripping leading SQL comments + whitespace).
  -- Strip both /* … */ and -- comments for the first-token check only.
  v_upper := regexp_replace(v_query, '/\*.*?\*/', '', 'g');
  v_upper := regexp_replace(v_upper, '--[^\n]*', '', 'g');
  v_upper := upper(btrim(v_upper));

  IF v_upper !~ '^(SELECT|WITH|TABLE|VALUES|EXPLAIN)\s' THEN
    RAISE EXCEPTION 'Only SELECT / WITH / TABLE / VALUES / EXPLAIN queries are allowed';
  END IF;

  -- Reject every write / DDL / control keyword as a whole word.
  -- Why word-boundary: catches "DELETE FROM x" but not "deleted_at".
  IF v_upper ~ '\m(INSERT|UPDATE|DELETE|MERGE|UPSERT|DROP|ALTER|CREATE|TRUNCATE|RENAME|GRANT|REVOKE|COPY|DO|CALL|VACUUM|ANALYZE|REINDEX|CLUSTER|LOCK|NOTIFY|LISTEN|UNLISTEN|RESET|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|START|PREPARE|DEALLOCATE|SECURITY|DEFINER)\M' THEN
    RAISE EXCEPTION 'Query contains a forbidden keyword (writes, DDL, or control statements are not allowed)';
  END IF;

  -- Clamp the row limit. Even if JS sends 999999, the wrapping subquery caps it.
  v_limit := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000);

  -- Per-statement timeouts. SET LOCAL inside SECURITY DEFINER applies to
  -- the inner EXECUTE just below. Caller's session settings are restored
  -- when the function returns.
  PERFORM set_config('statement_timeout', '10s', true);
  PERFORM set_config('lock_timeout',      '2s',  true);

  -- Bound the row count BEFORE aggregation (the LIMIT must wrap the user
  -- query, not the jsonb_agg output — aggregates always emit a single row).
  -- If the user wrote anything that doesn't return a row-set, the outer
  -- SELECT … FROM (X) fails with a clear parse error rather than executing
  -- a write.
  EXECUTE format(
    'SELECT COALESCE(jsonb_agg(to_jsonb(t)), ''[]''::jsonb), COUNT(*) FROM (SELECT * FROM (%s) AS inner_q LIMIT %s) AS t',
    v_query,
    v_limit
  ) INTO v_rows, v_count;

  v_duration := extract(epoch FROM (clock_timestamp() - v_started)) * 1000;

  RETURN jsonb_build_object(
    'rows',        v_rows,
    'row_count',   v_count,
    'duration_ms', round(v_duration, 1),
    'limit',       v_limit,
    'truncated',   (v_count = v_limit)
  );
END;
$$;

REVOKE ALL ON FUNCTION admin_run_sql(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_run_sql(TEXT, INTEGER) TO service_role;

COMMENT ON FUNCTION admin_run_sql(TEXT, INTEGER) IS
  'Admin v2 Tools — read-only SQL runner. Validates SELECT/WITH/TABLE/VALUES/EXPLAIN only, rejects writes/DDL/control keywords, wraps in a row-set subquery, caps at 1000 rows + 10 s statement_timeout. Service-role only.';

-- ── Verify ─────────────────────────────────────────────────────────────────
SELECT proname FROM pg_proc WHERE proname = 'admin_run_sql';

-- Smoke tests (paste each line individually if you want):
-- SELECT admin_run_sql('SELECT now() AS server_time, version()', 5);
-- SELECT admin_run_sql('SELECT count(*) FROM organisations', 1);
-- SELECT admin_run_sql('DROP TABLE organisations', 1);  -- expected: ERROR forbidden keyword
-- SELECT admin_run_sql('SELECT 1; SELECT 2', 1);        -- expected: ERROR multi-statement

COMMIT;
