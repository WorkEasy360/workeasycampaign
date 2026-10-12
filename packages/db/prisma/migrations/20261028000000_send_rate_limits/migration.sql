-- Sending-rate controls (Phase 7.11; docs/contracts/phase-7-campaign-amendment.md §R).
--  * campaign_executions.max_per_hour — an optional per-run limit set by a sender before or during the run (it takes
--    effect at the next batch). NULL = no campaign limit.
--  * send_rate_buckets — token buckets shared by every worker process: the provider-wide limit, each workspace's
--    fair share, and each run's limit. Taken BEFORE recipients are claimed, so nothing is claimed that cannot be sent.
--    Not tenant data (scope keys are ids); like job_queue: RLS forced, no policy, no grants, definer functions only.

ALTER TABLE "campaign_executions" ADD COLUMN "max_per_hour" INTEGER;
ALTER TABLE "campaign_executions" ADD CONSTRAINT campaign_executions_max_per_hour_chk CHECK (max_per_hour IS NULL OR max_per_hour BETWEEN 1 AND 1000000);
GRANT UPDATE ("max_per_hour") ON "campaign_executions" TO workeasy_app;

CREATE TABLE "send_rate_buckets" (
    "scope" TEXT NOT NULL,
    "tokens" DOUBLE PRECISION NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "send_rate_buckets_pkey" PRIMARY KEY ("scope"),
    CONSTRAINT send_rate_buckets_scope_chk CHECK (scope ~ '^(provider|workspace|execution):[A-Za-z0-9_.:-]{1,80}$')
);
REVOKE ALL ON "send_rate_buckets" FROM PUBLIC;
ALTER TABLE "send_rate_buckets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "send_rate_buckets" FORCE ROW LEVEL SECURITY;

-- Take up to p_wanted tokens from EVERY scope at once (all or the same amount from each): refill each bucket at its
-- rate (per second) up to its burst, grant the minimum available, subtract it everywhere. Rows are locked in scope
-- order (no deadlock between concurrent callers). Returns the grant and, when it is smaller than wanted, how long
-- until one more token is available in the slowest bucket.
CREATE FUNCTION app.take_send_tokens(p_scopes text[], p_rates float8[], p_bursts float8[], p_wanted int)
RETURNS TABLE (granted int, wait_ms int) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  n int := coalesce(array_length(p_scopes, 1), 0);
  i int;
  avail float8[] := ARRAY[]::float8[];
  t float8;
  g int;
  w float8 := 0;
  now_ts timestamptz := clock_timestamp();
BEGIN
  IF n = 0 OR n > 8 OR array_length(p_rates, 1) IS DISTINCT FROM n OR array_length(p_bursts, 1) IS DISTINCT FROM n THEN
    RAISE EXCEPTION 'take_send_tokens: 1 to 8 scopes, with one rate and one burst each';
  END IF;
  IF p_wanted < 1 OR p_wanted > 10000 THEN RAISE EXCEPTION 'take_send_tokens: wanted must be 1..10000'; END IF;
  FOR i IN 1..n LOOP
    IF p_rates[i] <= 0 OR p_bursts[i] < 1 THEN RAISE EXCEPTION 'take_send_tokens: rate > 0 and burst >= 1'; END IF;
  END LOOP;
  -- Create missing buckets full, then lock all of them in scope order.
  INSERT INTO send_rate_buckets (scope, tokens, updated_at)
    SELECT s, b, now_ts FROM unnest(p_scopes, p_bursts) AS x(s, b) ON CONFLICT (scope) DO NOTHING;
  PERFORM 1 FROM send_rate_buckets WHERE scope = ANY (p_scopes) ORDER BY scope FOR UPDATE;
  FOR i IN 1..n LOOP
    SELECT least(p_bursts[i], b.tokens + p_rates[i] * greatest(extract(epoch FROM now_ts - b.updated_at), 0))
      INTO t FROM send_rate_buckets b WHERE b.scope = p_scopes[i];
    avail := avail || t;
  END LOOP;
  g := least(p_wanted, floor((SELECT min(v) FROM unnest(avail) AS v))::int);
  IF g < 0 THEN g := 0; END IF;
  FOR i IN 1..n LOOP
    UPDATE send_rate_buckets SET tokens = avail[i] - g, updated_at = now_ts WHERE scope = p_scopes[i];
    IF g < p_wanted AND avail[i] - g < 1 THEN w := greatest(w, (1 - (avail[i] - g)) / p_rates[i]); END IF;
  END LOOP;
  -- Idle buckets are forgotten (a full bucket and a missing one are the same).
  DELETE FROM send_rate_buckets WHERE ctid = ANY (ARRAY(
    SELECT ctid FROM send_rate_buckets WHERE updated_at < now_ts - interval '1 day' AND NOT scope = ANY (p_scopes) LIMIT 50));
  RETURN QUERY SELECT g, ceil(w * 1000)::int;
END
$$;

-- Give back tokens that were taken but not used (recipients skipped at Checkpoint B, or a batch that stopped early).
CREATE FUNCTION app.refund_send_tokens(p_scopes text[], p_bursts float8[], p_count int)
RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE send_rate_buckets b SET tokens = least(x.burst, b.tokens + greatest(p_count, 0))
    FROM unnest(p_scopes, p_bursts) AS x(scope, burst)
   WHERE b.scope = x.scope
$$;

REVOKE ALL ON FUNCTION app.take_send_tokens(text[], float8[], float8[], int), app.refund_send_tokens(text[], float8[], int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.take_send_tokens(text[], float8[], float8[], int), app.refund_send_tokens(text[], float8[], int) TO workeasy_app;
