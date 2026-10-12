-- Fix of app.claim_jobs (20261024000000): PostgreSQL refuses FOR UPDATE inside UNION ("FOR UPDATE is not allowed with
-- UNION/INTERSECT/EXCEPT", MEASURED on the first call). Two separate locking selects instead — due queued jobs first,
-- then running jobs whose lease expired — each with SKIP LOCKED; then one update by id. Same signature and semantics.

CREATE OR REPLACE FUNCTION app.claim_jobs(p_worker text, p_names text[], p_limit int, p_lease_seconds int)
RETURNS TABLE (id uuid, name text, payload jsonb, attempts int, max_attempts int)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_due uuid[];
  v_expired uuid[];
  v_limit int := least(greatest(coalesce(p_limit, 1), 1), 100);
BEGIN
  IF p_worker IS NULL OR char_length(p_worker) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'claim_jobs: worker id required'; END IF;
  IF p_lease_seconds NOT BETWEEN 5 AND 3600 THEN RAISE EXCEPTION 'claim_jobs: lease must be 5–3600 s'; END IF;
  SELECT array_agg(x.id) INTO v_due FROM (
    SELECT q.id FROM job_queue q
     WHERE q.status = 'queued' AND q.run_after <= now() AND q.name = ANY(p_names)
     ORDER BY q.run_after, q.id LIMIT v_limit FOR UPDATE SKIP LOCKED) x;
  IF coalesce(array_length(v_due, 1), 0) < v_limit THEN
    SELECT array_agg(x.id) INTO v_expired FROM (
      SELECT q.id FROM job_queue q
       WHERE q.status = 'running' AND q.lease_until < now() AND q.name = ANY(p_names)
       ORDER BY q.lease_until, q.id LIMIT v_limit - coalesce(array_length(v_due, 1), 0) FOR UPDATE SKIP LOCKED) x;
  END IF;
  IF v_due IS NULL AND v_expired IS NULL THEN RETURN; END IF;
  RETURN QUERY
    UPDATE job_queue q
       SET status = 'running', attempts = q.attempts + 1, lease_owner = p_worker,
           lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
     WHERE q.id = ANY(coalesce(v_due, '{}') || coalesce(v_expired, '{}'))
    RETURNING q.id, q.name, q.payload, q.attempts, q.max_attempts;
END $$;

REVOKE ALL ON FUNCTION app.claim_jobs(text, text[], int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_jobs(text, text[], int, int) TO workeasy_app;
