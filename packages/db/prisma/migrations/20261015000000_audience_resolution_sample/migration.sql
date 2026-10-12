-- Audience Resolution v1.1 — uniform member sample (approved 2026-10-07; docs/contracts/phase-5-audience.md §9.9;
-- docs/audit/phase-6.7-6.8-preflight-lifecycle.md). Additive: two functions, no table, no grant on any table, no
-- change to Audience Resolution v1. Needed by Campaign pre-flight (contract phase-6-campaign §3.1: eligibility on a
-- uniform sample of ≤ 2,000 members) without creating a snapshot.
--
-- Read-only and Audience-owned: it reads the verified count bitmap of the CURRENT workspace (RLS-confined; the owner
-- role below is NOBYPASSRLS) and returns contact ids only. Named outside the `audience_count_` prefix on purpose: the
-- DDL guard invalidates every bitmap on DDL touching that prefix, and installing a reader must not do that.
--
-- Uniformity: with N members (bitmap positions set in OR(include) & ~OR(exclude) & ~dead), k = min(size, N) distinct
-- ranks are drawn uniformly from [0, N) — every k-subset equally likely (iid draws → distinct set is uniform among
-- subsets of its size; a uniform k-subset of it is uniform overall; for N ≤ 2k a random permutation of all ranks is
-- used). Each rank maps to exactly one member: chunk by prefix sums of per-chunk counts, bit by binary search over
-- prefix popcounts, contact by its position. Everything happens in ONE statement (one MVCC snapshot).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workeasy_audience_count') THEN
    RAISE EXCEPTION 'role workeasy_audience_count is missing: run pnpm db:bootstrap (superuser) before this migration';
  END IF;
END $$;

-- The 0-based offset of the (p_rank+1)-th set bit of a chunk: smallest m with bit_count(first m bits) >= p_rank + 1.
CREATE FUNCTION app.audience_sample_nth_bit(p_bits bit varying, p_rank int) RETURNS int
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
DECLARE lo int := 1; hi int := length(p_bits); mid int;
BEGIN
  IF p_rank < 0 OR p_rank >= bit_count(p_bits) THEN RAISE EXCEPTION 'rank % outside the chunk', p_rank USING ERRCODE = 'invalid_parameter_value'; END IF;
  WHILE lo < hi LOOP
    mid := (lo + hi) / 2;
    IF bit_count(substring(p_bits FROM 1 FOR mid)) >= p_rank + 1 THEN hi := mid; ELSE lo := mid + 1; END IF;
  END LOOP;
  RETURN lo - 1;
END $$;

-- Uniform sample of the live audience of the CURRENT workspace from its verified bitmap.
-- Returns {"state": "<state>"} when the workspace's bitmap is not valid (the caller then uses the exact query), else
-- {"state": "valid", "total": N, "contactIds": [...]} with min(p_size, N) ids, ascending. p_seed (−1…1) makes the draw
-- repeatable (tests); NULL = fresh randomness.
CREATE FUNCTION app.audience_sample_ids(p_include uuid[], p_exclude uuid[], p_size int, p_seed double precision)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ws uuid := app.current_workspace_id();
  z bit varying := repeat('0', 4096)::bit varying;
  st text;
  chunks bigint[]; counts bigint[]; vs bit varying[];
  total bigint := 0;
  ranks bigint[];
  draws int;
  ids uuid[];
BEGIN
  IF ws IS NULL THEN RAISE EXCEPTION 'sampling needs a workspace context' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_size IS NULL OR p_size < 0 OR p_size > 2000 THEN RAISE EXCEPTION 'sample size must be 0–2000' USING ERRCODE = 'invalid_parameter_value'; END IF;
  SELECT state INTO st FROM public.audience_count_state WHERE workspace_id = ws;
  IF st IS DISTINCT FROM 'valid' THEN RETURN jsonb_build_object('state', coalesce(st, 'missing')); END IF;
  IF p_seed IS NOT NULL THEN PERFORM setseed(p_seed); END IF;

  SELECT coalesce(array_agg(a.chunk ORDER BY a.chunk), '{}'), coalesce(array_agg(bit_count(a.v) ORDER BY a.chunk), '{}'),
         coalesce(array_agg(a.v ORDER BY a.chunk), '{}')
    INTO chunks, counts, vs
    FROM (SELECT i.chunk, i.v & ~coalesce(e.v, z) & ~coalesce(d.bits, z) AS v
            FROM (SELECT chunk, bit_or(bits) AS v FROM public.audience_count_source_chunks WHERE source_id = ANY (p_include) GROUP BY chunk) i
            LEFT JOIN (SELECT chunk, bit_or(bits) AS v FROM public.audience_count_source_chunks WHERE source_id = ANY (p_exclude) GROUP BY chunk) e
                   ON e.chunk = i.chunk
            LEFT JOIN public.audience_count_dead_chunks d ON d.workspace_id = ws AND d.chunk = i.chunk) a
   WHERE bit_count(a.v) > 0;
  SELECT coalesce(sum(n), 0) INTO total FROM unnest(counts) n;

  IF total = 0 OR p_size = 0 THEN
    RETURN jsonb_build_object('state', 'valid', 'total', total, 'contactIds', '[]'::jsonb);
  ELSIF total <= p_size::bigint * 2 THEN
    SELECT array_agg(r) INTO ranks FROM (SELECT r FROM generate_series(0::bigint, total - 1) r ORDER BY random() LIMIT p_size) x;
  ELSE
    draws := p_size * 3;
    LOOP
      SELECT array_agg(r) INTO ranks FROM (SELECT DISTINCT floor(random() * total)::bigint AS r FROM generate_series(1, draws)) x;
      EXIT WHEN cardinality(ranks) >= p_size;
      draws := draws * 2;
    END LOOP;
    SELECT array_agg(r) INTO ranks FROM (SELECT r FROM unnest(ranks) r ORDER BY random() LIMIT p_size) x;
  END IF;

  WITH c AS (SELECT u.ch, u.n, u.v, sum(u.n) OVER (ORDER BY u.ord) - u.n AS before
               FROM unnest(chunks, counts, vs) WITH ORDINALITY AS u(ch, n, v, ord)),
       hit AS (SELECT c.ch, app.audience_sample_nth_bit(c.v, (r.r - c.before)::int) AS off
                 FROM unnest(ranks) AS r(r) JOIN c ON r.r >= c.before AND r.r < c.before + c.n)
  SELECT array_agg(s.contact_id ORDER BY s.contact_id) INTO ids
    FROM hit JOIN public.audience_count_contact_seq s ON s.seq = hit.ch * 4096 + hit.off;

  RETURN jsonb_build_object('state', 'valid', 'total', total, 'contactIds', to_jsonb(coalesce(ids, '{}')));
END $$;

-- Owned by the NOBYPASSRLS maintenance role (it may read positions and chunks; RLS confines it to the session's
-- workspace). ALTER OWNER needs CREATE on the schema for this step only.
GRANT CREATE ON SCHEMA app TO workeasy_audience_count;
ALTER FUNCTION app.audience_sample_nth_bit(bit varying, int) OWNER TO workeasy_audience_count;
ALTER FUNCTION app.audience_sample_ids(uuid[], uuid[], int, double precision) OWNER TO workeasy_audience_count;
REVOKE CREATE ON SCHEMA app FROM workeasy_audience_count;
REVOKE ALL ON FUNCTION app.audience_sample_nth_bit(bit varying, int), app.audience_sample_ids(uuid[], uuid[], int, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.audience_sample_ids(uuid[], uuid[], int, double precision) TO workeasy_app;
