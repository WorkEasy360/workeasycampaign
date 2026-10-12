-- Durable job queue (Phase 7.6; docs/architecture/durable-job-queue.md; owner decision 2026-10-09).
--
-- Access model: the runtime role has NO privilege on job_queue (RLS enabled AND forced, no policy, no grant). Every
-- operation goes through the SECURITY DEFINER functions below (owned by the migration owner, which bypasses RLS),
-- each with a pinned search_path and EXECUTE for the runtime role only. The tenant of a job is taken from the
-- database session's tenant context at enqueue — never from the payload — and the payload's own tenant must match it.
--
-- Claims lock ids first and update by id (never `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`: a planner
-- trap measured in audit 6.13 §2).

CREATE TABLE job_queue (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    org_id UUID NOT NULL,
    workspace_id UUID,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 8,
    run_after TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    lease_owner TEXT,
    lease_until TIMESTAMPTZ(3),
    dedupe_key TEXT,
    last_error TEXT,
    created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ(3),
    CONSTRAINT job_queue_pkey PRIMARY KEY (id),
    CONSTRAINT job_queue_name_chk CHECK (name ~ '^[a-z][a-z0-9_.]{0,99}$'),
    CONSTRAINT job_queue_status_chk CHECK (status IN ('queued', 'running', 'done', 'dead')),
    CONSTRAINT job_queue_attempts_chk CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 50),
    CONSTRAINT job_queue_lease_chk CHECK ((status = 'running') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
    CONSTRAINT job_queue_error_chk CHECK (last_error IS NULL OR char_length(last_error) <= 200),
    CONSTRAINT job_queue_dedupe_chk CHECK (dedupe_key IS NULL OR char_length(dedupe_key) BETWEEN 1 AND 200),
    CONSTRAINT job_queue_payload_chk CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX job_queue_due_idx ON job_queue (run_after, id) WHERE status = 'queued';
CREATE INDEX job_queue_lease_idx ON job_queue (lease_until) WHERE status = 'running';
CREATE INDEX job_queue_finished_idx ON job_queue (finished_at) WHERE status IN ('done', 'dead');
CREATE UNIQUE INDEX job_queue_dedupe_key ON job_queue (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

REVOKE ALL ON job_queue FROM PUBLIC;
ALTER TABLE job_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_queue FORCE ROW LEVEL SECURITY;
-- No policy: nobody without BYPASSRLS (i.e. the runtime role) can see or change a row directly.

-- ─── enqueue: inside the caller's tenant transaction ─────────────────────────────────────────────────────────────
CREATE FUNCTION app.enqueue_job(p_name text, p_payload jsonb, p_run_after timestamptz, p_max_attempts int, p_dedupe_key text)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_org uuid := app.current_org_id();
  v_ws uuid := app.current_workspace_id();
  v_id uuid;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'enqueue_job: no tenant context' USING ERRCODE = '42501'; END IF;
  IF (p_payload #>> '{tenant,orgId}')::uuid IS DISTINCT FROM v_org
     OR (p_payload #>> '{tenant,workspaceId}')::uuid IS DISTINCT FROM v_ws THEN
    RAISE EXCEPTION 'enqueue_job: the payload tenant does not match the session tenant' USING ERRCODE = '42501';
  END IF;
  INSERT INTO job_queue (name, org_id, workspace_id, payload, run_after, max_attempts, dedupe_key)
  VALUES (p_name, v_org, v_ws, p_payload, coalesce(p_run_after, now()), coalesce(p_max_attempts, 8), p_dedupe_key)
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running') DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id; -- null: an equal job (same dedupe key) is already queued or running
END $$;

-- ─── claim: due jobs and jobs whose lease expired; ids locked first, then updated by id ─────────────────────────
CREATE FUNCTION app.claim_jobs(p_worker text, p_names text[], p_limit int, p_lease_seconds int)
RETURNS TABLE (id uuid, name text, payload jsonb, attempts int, max_attempts int)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_ids uuid[];
  v_limit int := least(greatest(coalesce(p_limit, 1), 1), 100);
BEGIN
  IF p_worker IS NULL OR char_length(p_worker) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'claim_jobs: worker id required'; END IF;
  IF p_lease_seconds NOT BETWEEN 5 AND 3600 THEN RAISE EXCEPTION 'claim_jobs: lease must be 5–3600 s'; END IF;
  SELECT array_agg(c.id) INTO v_ids FROM (
    (SELECT q.id FROM job_queue q
      WHERE q.status = 'queued' AND q.run_after <= now() AND q.name = ANY(p_names)
      ORDER BY q.run_after, q.id LIMIT v_limit FOR UPDATE SKIP LOCKED)
    UNION ALL
    (SELECT q.id FROM job_queue q
      WHERE q.status = 'running' AND q.lease_until < now() AND q.name = ANY(p_names)
      ORDER BY q.lease_until, q.id LIMIT v_limit FOR UPDATE SKIP LOCKED)
  ) c;
  IF v_ids IS NULL THEN RETURN; END IF;
  RETURN QUERY
    UPDATE job_queue q
       SET status = 'running', attempts = q.attempts + 1, lease_owner = p_worker,
           lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
     WHERE q.id = ANY(v_ids[1:v_limit])
    RETURNING q.id, q.name, q.payload, q.attempts, q.max_attempts;
END $$;

-- ─── heartbeat, completion, failure: only by the worker holding the lease ─────────────────────────────────────────
CREATE FUNCTION app.extend_job_lease(p_id uuid, p_worker text, p_lease_seconds int)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH u AS (
    UPDATE job_queue SET lease_until = now() + make_interval(secs => least(greatest(p_lease_seconds, 5), 3600)), updated_at = now()
     WHERE id = p_id AND status = 'running' AND lease_owner = p_worker RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

CREATE FUNCTION app.complete_job(p_id uuid, p_worker text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH u AS (
    UPDATE job_queue SET status = 'done', lease_owner = NULL, lease_until = NULL, last_error = NULL, finished_at = now(), updated_at = now()
     WHERE id = p_id AND status = 'running' AND lease_owner = p_worker RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

-- Retry (back to queued, not before now + retry_in) unless permanent or out of attempts (dead letter).
CREATE FUNCTION app.fail_job(p_id uuid, p_worker text, p_error text, p_retry_in_seconds int, p_permanent boolean)
RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH u AS (
    UPDATE job_queue
       SET status = CASE WHEN p_permanent OR attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
           run_after = CASE WHEN p_permanent OR attempts >= max_attempts THEN run_after
                            ELSE now() + make_interval(secs => least(greatest(coalesce(p_retry_in_seconds, 0), 0), 86400)) END,
           finished_at = CASE WHEN p_permanent OR attempts >= max_attempts THEN now() END,
           lease_owner = NULL, lease_until = NULL, last_error = left(coalesce(p_error, 'UNKNOWN'), 200), updated_at = now()
     WHERE id = p_id AND status = 'running' AND lease_owner = p_worker
    RETURNING status)
  SELECT status FROM u
$$;

-- ─── operations: depth/lag for metrics, retention ────────────────────────────────────────────────────────────────
CREATE FUNCTION app.job_queue_stats()
RETURNS TABLE (name text, status text, jobs bigint, oldest_due_seconds double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT name, status, count(*),
         max(CASE WHEN status = 'queued' AND run_after <= now() THEN extract(epoch FROM now() - run_after) END)
    FROM job_queue GROUP BY name, status
$$;

CREATE FUNCTION app.purge_jobs(p_finished_before timestamptz, p_limit int)
RETURNS int LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH v AS (
    SELECT id FROM job_queue WHERE status IN ('done', 'dead') AND finished_at < p_finished_before
     ORDER BY finished_at LIMIT least(greatest(p_limit, 1), 10000)),
  d AS (DELETE FROM job_queue q USING v WHERE q.id = v.id RETURNING 1)
  SELECT count(*)::int FROM d
$$;

REVOKE ALL ON FUNCTION app.enqueue_job(text, jsonb, timestamptz, int, text), app.claim_jobs(text, text[], int, int),
  app.extend_job_lease(uuid, text, int), app.complete_job(uuid, text), app.fail_job(uuid, text, text, int, boolean),
  app.job_queue_stats(), app.purge_jobs(timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.enqueue_job(text, jsonb, timestamptz, int, text), app.claim_jobs(text, text[], int, int),
  app.extend_job_lease(uuid, text, int), app.complete_job(uuid, text), app.fail_job(uuid, text, text, int, boolean),
  app.job_queue_stats(), app.purge_jobs(timestamptz, int) TO workeasy_app;
