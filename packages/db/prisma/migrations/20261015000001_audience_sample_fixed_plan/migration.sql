-- Audience Resolution v1.1 — sample: plan made deterministic (docs/audit/phase-6.7-6.8-preflight-lifecycle.md §Performance).
-- Additive (the applied 20261015000000 migration is not modified). Part A (prisma migrate diff): empty — no schema change.
-- Part B (hand-written): CREATE OR REPLACE of app.audience_sample_ids with the same signature, semantics, owner
-- (workeasy_audience_count, NOBYPASSRLS), grants and result.
--
-- MEASURED defect of the first version: the rank → member mapping joined the ranks to the chunks with a range
-- predicate and then to audience_count_contact_seq on an expression containing app.audience_sample_nth_bit(). The
-- planner may place that opaque function in a join condition over every contact position (it did, through the API at
-- 100,000 contacts: the statement hit the 15 s statement_timeout; a fresh session chose a 53 ms plan). Correctness
-- must not depend on that choice.
--
-- Now: (1) a rank's chunk is width_bucket(rank, prefix sums) — prefix sums are strictly increasing because empty
-- chunks are dropped; (2) the positions are computed in ONE scan of the rank array (exactly one nth_bit call per
-- rank, no join); (3) contacts are fetched by `seq = ANY(positions)` on the unique seq index. Every step is bounded
-- by the sample size (≤ 2,000) or the number of chunks, not by the workspace size.

CREATE OR REPLACE FUNCTION app.audience_sample_ids(p_include uuid[], p_exclude uuid[], p_size int, p_seed double precision)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ws uuid := app.current_workspace_id();
  z bit varying := repeat('0', 4096)::bit varying;
  st text;
  chunks bigint[]; counts bigint[]; vs bit varying[]; befores bigint[];
  total bigint := 0;
  ranks bigint[];
  positions bigint[];
  draws int;
  ids uuid[];
BEGIN
  IF ws IS NULL THEN RAISE EXCEPTION 'sampling needs a workspace context' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_size IS NULL OR p_size < 0 OR p_size > 2000 THEN RAISE EXCEPTION 'sample size must be 0–2000' USING ERRCODE = 'invalid_parameter_value'; END IF;
  SELECT state INTO st FROM public.audience_count_state WHERE workspace_id = ws;
  IF st IS DISTINCT FROM 'valid' THEN RETURN jsonb_build_object('state', coalesce(st, 'missing')); END IF;
  IF p_seed IS NOT NULL THEN PERFORM setseed(p_seed); END IF;

  -- Per chunk: audience bits = OR(include) & ~OR(exclude) & ~dead; only non-empty chunks, ascending.
  SELECT coalesce(array_agg(a.chunk ORDER BY a.chunk), '{}'), coalesce(array_agg(bit_count(a.v) ORDER BY a.chunk), '{}'),
         coalesce(array_agg(a.v ORDER BY a.chunk), '{}')
    INTO chunks, counts, vs
    FROM (SELECT i.chunk, i.v & ~coalesce(e.v, z) & ~coalesce(d.bits, z) AS v
            FROM (SELECT chunk, bit_or(bits) AS v FROM public.audience_count_source_chunks WHERE source_id = ANY (p_include) GROUP BY chunk) i
            LEFT JOIN (SELECT chunk, bit_or(bits) AS v FROM public.audience_count_source_chunks WHERE source_id = ANY (p_exclude) GROUP BY chunk) e
                   ON e.chunk = i.chunk
            LEFT JOIN public.audience_count_dead_chunks d ON d.workspace_id = ws AND d.chunk = i.chunk) a
   WHERE bit_count(a.v) > 0;
  -- befores[i] = members in chunks 1..i-1 (strictly increasing: every listed chunk has ≥ 1 member).
  SELECT coalesce(array_agg(b ORDER BY o), '{}'), coalesce(max(b + n), 0) INTO befores, total
    FROM (SELECT o, n, sum(n) OVER (ORDER BY o) - n AS b FROM unnest(counts) WITH ORDINALITY AS u(n, o)) x;

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

  -- One pass over the ranks, no join: chunk by width_bucket over the prefix sums, bit by binary search.
  SELECT array_agg(chunks[b] * 4096 + app.audience_sample_nth_bit(vs[b], (r - befores[b])::int)) INTO positions
    FROM (SELECT r, width_bucket(r, befores) AS b FROM unnest(ranks) AS r) x;

  SELECT array_agg(s.contact_id ORDER BY s.contact_id) INTO ids
    FROM public.audience_count_contact_seq s
   WHERE s.seq = ANY (positions) AND s.workspace_id = ws;
  IF cardinality(ids) IS DISTINCT FROM cardinality(positions) THEN
    -- A position without a contact means the bitmap disagrees with the positions table: never return a short sample.
    -- Answer like a non-valid bitmap, so the caller uses the exact query (the count path's reconcile repairs it).
    RETURN jsonb_build_object('state', 'inconsistent');
  END IF;

  RETURN jsonb_build_object('state', 'valid', 'total', total, 'contactIds', to_jsonb(ids));
END $$;
