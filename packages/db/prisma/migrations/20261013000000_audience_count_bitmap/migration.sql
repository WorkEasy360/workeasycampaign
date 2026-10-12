-- Audience count bitmap: the derived EXACT membership count (Phase 6.3 Gate G2; design and evidence:
-- docs/audit/phase-6.3-count-architecture-decision.md, phase-6.3-bitmap-production-readiness.md,
-- phase-6.3-bitmap-online-rebuild-readiness.md, phase-6.3-g2-closure.md).
--
-- Additive and non-destructive: four new Audience-owned tables, one sequence, maintenance functions and triggers.
-- No existing table, column, grant or policy is changed or removed. Every existing workspace starts INVALID, so the
-- count keeps using the exact query until the maintenance job has rebuilt AND verified that workspace's bitmap.
--
-- Requires (pnpm db:bootstrap): role workeasy_audience_count (NOLOGIN, NOBYPASSRLS) with workeasy_owner as a member,
-- and the DDL guard event triggers. The migration refuses to run without the role.
--
-- The count is   Σ over chunks of bit_count( OR(include chunks) & ~OR(exclude chunks) & ~dead chunk ),
-- served ONLY when audience_count_state.state = 'valid'. Positions: one global sequence number per contact
-- (audience_count_contact_seq); chunk = seq / 4096, bit = seq % 4096.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workeasy_audience_count') THEN
    RAISE EXCEPTION 'role workeasy_audience_count is missing: run pnpm db:bootstrap (superuser) before this migration';
  END IF;
END $$;

-- ═══ Part A: generated (prisma migrate diff) ═══

-- CreateTable
CREATE TABLE "audience_count_state" (
    "org_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "generation" BIGINT NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL DEFAULT '',
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rebuild_token" UUID,
    "rebuild_lease_until" TIMESTAMPTZ(3),
    "last_reconciled_at" TIMESTAMPTZ(3),
    "last_reconcile_result" JSONB,

    CONSTRAINT "audience_count_state_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "audience_count_contact_seq" (
    "org_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,

    CONSTRAINT "audience_count_contact_seq_pkey" PRIMARY KEY ("contact_id")
);

-- CreateTable
CREATE TABLE "audience_count_source_chunks" (
    "org_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "chunk" BIGINT NOT NULL,
    "bits" bit varying NOT NULL,

    CONSTRAINT "audience_count_source_chunks_pkey" PRIMARY KEY ("workspace_id","source_id","chunk")
);

-- CreateTable
CREATE TABLE "audience_count_dead_chunks" (
    "org_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "chunk" BIGINT NOT NULL,
    "bits" bit varying NOT NULL,

    CONSTRAINT "audience_count_dead_chunks_pkey" PRIMARY KEY ("workspace_id","chunk")
);

-- CreateIndex
CREATE UNIQUE INDEX "audience_count_state_org_id_workspace_id_key" ON "audience_count_state"("org_id", "workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "audience_count_contact_seq_seq_key" ON "audience_count_contact_seq"("seq");

-- AddForeignKey
ALTER TABLE "audience_count_state" ADD CONSTRAINT "audience_count_state_org_id_workspace_id_fkey" FOREIGN KEY ("org_id", "workspace_id") REFERENCES "workspaces"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audience_count_contact_seq" ADD CONSTRAINT "audience_count_contact_seq_org_id_workspace_id_contact_id_fkey" FOREIGN KEY ("org_id", "workspace_id", "contact_id") REFERENCES "contacts"("org_id", "workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audience_count_source_chunks" ADD CONSTRAINT "audience_count_source_chunks_org_id_workspace_id_fkey" FOREIGN KEY ("org_id", "workspace_id") REFERENCES "workspaces"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audience_count_dead_chunks" ADD CONSTRAINT "audience_count_dead_chunks_org_id_workspace_id_fkey" FOREIGN KEY ("org_id", "workspace_id") REFERENCES "workspaces"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══ Part B: hand-written ═══

-- ─── 1. Constraints ───────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "audience_count_state"
  ADD CONSTRAINT audience_count_state_state_chk CHECK (state IN ('valid', 'invalid', 'rebuilding')),
  ADD CONSTRAINT audience_count_state_lease_chk CHECK ((rebuild_token IS NULL) = (rebuild_lease_until IS NULL)),
  ADD CONSTRAINT audience_count_state_reason_chk CHECK (char_length(reason) <= 500);
ALTER TABLE "audience_count_source_chunks" ADD CONSTRAINT audience_count_source_chunks_bits_chk CHECK (length(bits) = 4096 AND chunk >= 0);
ALTER TABLE "audience_count_dead_chunks" ADD CONSTRAINT audience_count_dead_chunks_bits_chk CHECK (length(bits) = 4096 AND chunk >= 0);
ALTER TABLE "audience_count_source_chunks" ALTER COLUMN bits SET STORAGE MAIN; -- 512 bytes, kept inline
ALTER TABLE "audience_count_dead_chunks" ALTER COLUMN bits SET STORAGE MAIN;
ALTER TABLE "audience_count_contact_seq" ADD CONSTRAINT audience_count_contact_seq_seq_chk CHECK (seq >= 0);
CREATE SEQUENCE app.audience_count_seq_gen AS bigint MINVALUE 0 START 0;

-- ─── 2. Row-level security: workspace-owned, forced, InitPlan form (identical predicate) ────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audience_count_state', 'audience_count_contact_seq', 'audience_count_source_chunks', 'audience_count_dead_chunks']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL
         USING (org_id = (SELECT app.current_org_id()) AND workspace_id = (SELECT app.current_workspace_id()))
         WITH CHECK (org_id = (SELECT app.current_org_id()) AND workspace_id = (SELECT app.current_workspace_id()))',
      t || '_workspace', t);
  END LOOP;
END $$;

-- ─── 3. Privileges (least privilege) ────────────────────────────────────────────────────────────────────────────
-- The runtime role READS what the count needs and nothing else; it never writes bitmap data directly.
GRANT SELECT ON "audience_count_state", "audience_count_source_chunks", "audience_count_dead_chunks" TO workeasy_app;
-- The maintenance role (owner of the functions below; NOBYPASSRLS, so RLS confines it to the session's workspace)
-- reads the Audience tables it derives from and writes only the bitmap tables. DELETE only for garbage collection.
GRANT USAGE ON SCHEMA public, app TO workeasy_audience_count;
GRANT EXECUTE ON FUNCTION app.current_org_id(), app.current_workspace_id() TO workeasy_audience_count;
GRANT SELECT ON "contacts", "list_memberships", "contact_tags" TO workeasy_audience_count;
GRANT SELECT, INSERT ON "audience_count_contact_seq" TO workeasy_audience_count;
GRANT SELECT, INSERT, UPDATE, DELETE ON "audience_count_source_chunks", "audience_count_dead_chunks" TO workeasy_audience_count;
GRANT SELECT, INSERT, UPDATE ON "audience_count_state" TO workeasy_audience_count;
GRANT USAGE ON SEQUENCE app.audience_count_seq_gen TO workeasy_audience_count;
-- Nothing for workeasy_reporting or workeasy_identity.

-- ─── 4. Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────
-- A 4,096-bit mask with the given positions set.
CREATE FUNCTION app.audience_count_mask(p_offsets int[]) RETURNS bit varying
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
DECLARE b bit varying := repeat('0', 4096)::bit varying; o int;
BEGIN
  FOREACH o IN ARRAY p_offsets LOOP b := set_bit(b, o, 1); END LOOP;
  RETURN b;
END $$;

-- Lock keys: one per (source, chunk) and per (workspace, dead chunk). Writers take them SHARED, the rebuild and the
-- garbage collector EXCLUSIVE and only for one short transaction. A hash collision only adds waiting.
CREATE FUNCTION app.audience_count_source_key(p_source uuid, p_chunk bigint) RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$ SELECT hashtextextended(p_source::text || ':' || p_chunk::text, 6301) $$;
CREATE FUNCTION app.audience_count_dead_key(p_workspace uuid, p_chunk bigint) RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$ SELECT hashtextextended(p_workspace::text || ':dead:' || p_chunk::text, 6302) $$;

-- Marks the CURRENT workspace's bitmap invalid (bumps the generation, drops any rebuild lease). RLS confines it.
CREATE FUNCTION app.audience_count_invalidate(p_reason text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE public.audience_count_state
     SET state = 'invalid', generation = generation + 1, reason = left(p_reason, 500),
         rebuild_token = NULL, rebuild_lease_until = NULL, changed_at = now()
   WHERE workspace_id = app.current_workspace_id()
$$;

-- Marks the given workspaces invalid. Used when a write happens OUTSIDE the matching tenant context (owner/admin
-- sessions, e.g. data repair or fixtures), where the RLS-confined maintenance cannot see the rows. Owner-owned
-- (BYPASSRLS); executable only by the maintenance role, i.e. only from the trigger functions below. Fail-safe: an
-- invalidation can only route counts to the exact query, never change a count.
CREATE FUNCTION app.audience_count_invalidate_workspaces(p_workspaces uuid[], p_reason text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE public.audience_count_state
     SET state = 'invalid', generation = generation + 1, reason = left(p_reason, 500),
         rebuild_token = NULL, rebuild_lease_until = NULL, changed_at = now()
   WHERE workspace_id = ANY (p_workspaces)
$$;

-- Statement-level: invalidates every workspace in the old transition rows. For write kinds the application never
-- performs (membership UPDATE, contact hard DELETE: the runtime role has no such privilege), so they cannot drift.
CREATE FUNCTION app.audience_count_trg_invalidate_rows() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM app.audience_count_invalidate_workspaces((SELECT array_agg(DISTINCT workspace_id) FROM old_rows), TG_OP || ' ' || TG_TABLE_NAME);
  RETURN NULL;
END $$;

-- Whether the CURRENT workspace's bitmap is being served. Inconsistencies found while it is not served (e.g. a
-- membership change for a contact the first rebuild has not given a position yet) need no invalidation: the rebuild
-- repairs every chunk afterwards and publishes VALID only after verifying the whole bitmap.
CREATE FUNCTION app.audience_count_is_valid() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((SELECT state = 'valid' FROM public.audience_count_state WHERE workspace_id = app.current_workspace_id()), false)
$$;

-- ─── 5. Maintenance triggers (same transaction as the write; every write path, including bulk and imports) ──────
-- Membership changes: statement level, transition tables; (source, chunk) in ascending order; commutative bit
-- operations on the latest row version (no lost update). Unexpected failures mark the bitmap INVALID instead of
-- failing the user's write; deadlocks, serialization failures and lock timeouts are re-raised so the caller retries.
CREATE FUNCTION app.audience_count_trg_members() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r record; col text := TG_ARGV[0]; tbl text := CASE WHEN TG_OP = 'INSERT' THEN 'new_rows' ELSE 'old_rows' END; missing bigint; foreign_ws uuid[];
BEGIN
  -- Rows outside the session's tenant context are invisible to RLS-confined maintenance: invalidate those workspaces.
  EXECUTE format('SELECT array_agg(DISTINCT workspace_id) FROM %I WHERE workspace_id IS DISTINCT FROM app.current_workspace_id() OR org_id IS DISTINCT FROM app.current_org_id()', tbl) INTO foreign_ws;
  IF foreign_ws IS NOT NULL THEN
    EXECUTE format('SELECT array_agg(DISTINCT workspace_id) FROM %I', tbl) INTO foreign_ws;
    PERFORM app.audience_count_invalidate_workspaces(foreign_ws, TG_OP || ' ' || TG_TABLE_NAME || ' outside its tenant context');
    RETURN NULL;
  END IF;
  BEGIN
    EXECUTE format('SELECT count(*) FROM %I t WHERE NOT EXISTS (SELECT 1 FROM public.audience_count_contact_seq s WHERE s.contact_id = t.contact_id)', tbl) INTO missing;
    IF missing > 0 AND app.audience_count_is_valid() THEN
      PERFORM app.audience_count_invalidate('membership change for a contact without a position'); RETURN NULL;
    END IF; -- not served: rows without a position are skipped (the join drops them); the rebuild repairs their chunks
    FOR r IN EXECUTE format(
      'SELECT t.org_id, t.workspace_id, t.%I AS src, s.seq / 4096 AS chunk, array_agg((s.seq %% 4096)::int) AS offs
         FROM %I t JOIN public.audience_count_contact_seq s ON s.contact_id = t.contact_id
        GROUP BY 1, 2, 3, 4 ORDER BY 3, 4', col, tbl) LOOP
      PERFORM pg_advisory_xact_lock_shared(app.audience_count_source_key(r.src, r.chunk));
      IF TG_OP = 'INSERT' THEN
        INSERT INTO public.audience_count_source_chunks AS c (org_id, workspace_id, source_id, chunk, bits)
        VALUES (r.org_id, r.workspace_id, r.src, r.chunk, app.audience_count_mask(r.offs))
        ON CONFLICT (workspace_id, source_id, chunk) DO UPDATE SET bits = c.bits | EXCLUDED.bits;
      ELSE
        UPDATE public.audience_count_source_chunks SET bits = bits & ~app.audience_count_mask(r.offs)
         WHERE workspace_id = r.workspace_id AND source_id = r.src AND chunk = r.chunk;
        IF NOT FOUND AND app.audience_count_is_valid() THEN PERFORM app.audience_count_invalidate('removed membership had no chunk'); END IF;
      END IF;
    END LOOP;
  EXCEPTION
    WHEN deadlock_detected OR serialization_failure OR lock_not_available THEN RAISE;
    WHEN OTHERS THEN PERFORM app.audience_count_invalidate('maintenance failed: ' || SQLSTATE || ' ' || SQLERRM);
  END;
  RETURN NULL;
END $$;

-- New contacts: statement level (one pass per INSERT, also for imports and bulk creates). Positions come from a
-- sequence (no hot row), allocated in ascending contact-id order. Contacts created already deleted/erased get their
-- dead bits, chunk by chunk in ascending order under the shared chunk lock.
CREATE FUNCTION app.audience_count_trg_contact_ins() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r record; foreign_ws uuid[];
BEGIN
  SELECT array_agg(DISTINCT workspace_id) INTO foreign_ws FROM new_rows
   WHERE workspace_id IS DISTINCT FROM app.current_workspace_id() OR org_id IS DISTINCT FROM app.current_org_id();
  IF foreign_ws IS NOT NULL THEN
    SELECT array_agg(DISTINCT workspace_id) INTO foreign_ws FROM new_rows;
    PERFORM app.audience_count_invalidate_workspaces(foreign_ws, 'INSERT contacts outside its tenant context');
    RETURN NULL;
  END IF;
  BEGIN
    INSERT INTO public.audience_count_contact_seq (org_id, workspace_id, contact_id, seq)
    SELECT n.org_id, n.workspace_id, n.id, nextval('app.audience_count_seq_gen') FROM (SELECT org_id, workspace_id, id FROM new_rows ORDER BY id) n;
    FOR r IN SELECT n.org_id, n.workspace_id, s.seq / 4096 AS chunk, array_agg((s.seq % 4096)::int) AS offs
               FROM new_rows n JOIN public.audience_count_contact_seq s ON s.contact_id = n.id
              WHERE n.deleted_at IS NOT NULL OR n.erased_at IS NOT NULL
              GROUP BY 1, 2, 3 ORDER BY 3 LOOP
      PERFORM pg_advisory_xact_lock_shared(app.audience_count_dead_key(r.workspace_id, r.chunk));
      INSERT INTO public.audience_count_dead_chunks AS d (org_id, workspace_id, chunk, bits)
      VALUES (r.org_id, r.workspace_id, r.chunk, app.audience_count_mask(r.offs))
      ON CONFLICT (workspace_id, chunk) DO UPDATE SET bits = d.bits | EXCLUDED.bits;
    END LOOP;
  EXCEPTION
    WHEN deadlock_detected OR serialization_failure OR lock_not_available THEN RAISE;
    WHEN OTHERS THEN PERFORM app.audience_count_invalidate('maintenance failed: ' || SQLSTATE || ' ' || SQLERRM);
  END;
  RETURN NULL;
END $$;

-- Liveness change (delete, erase, restore): fires only when live ⇄ non-live actually changes.
CREATE FUNCTION app.audience_count_trg_contact_live() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE s bigint;
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM app.current_workspace_id() OR NEW.org_id IS DISTINCT FROM app.current_org_id() THEN
    PERFORM app.audience_count_invalidate_workspaces(ARRAY[NEW.workspace_id], TG_OP || ' contacts outside its tenant context');
    RETURN NULL;
  END IF;
  BEGIN
    SELECT seq INTO s FROM public.audience_count_contact_seq WHERE contact_id = NEW.id;
    IF s IS NULL THEN
      IF app.audience_count_is_valid() THEN PERFORM app.audience_count_invalidate('liveness change for a contact without a position'); END IF;
      RETURN NULL;
    END IF;
    PERFORM pg_advisory_xact_lock_shared(app.audience_count_dead_key(NEW.workspace_id, s / 4096));
    IF NEW.deleted_at IS NOT NULL OR NEW.erased_at IS NOT NULL THEN
      INSERT INTO public.audience_count_dead_chunks AS d (org_id, workspace_id, chunk, bits)
      VALUES (NEW.org_id, NEW.workspace_id, s / 4096, app.audience_count_mask(ARRAY[(s % 4096)::int]))
      ON CONFLICT (workspace_id, chunk) DO UPDATE SET bits = d.bits | EXCLUDED.bits;
    ELSE
      UPDATE public.audience_count_dead_chunks SET bits = bits & ~app.audience_count_mask(ARRAY[(s % 4096)::int])
       WHERE workspace_id = NEW.workspace_id AND chunk = s / 4096;
      IF NOT FOUND AND app.audience_count_is_valid() THEN PERFORM app.audience_count_invalidate('restored contact had no dead chunk'); END IF;
    END IF;
  EXCEPTION
    WHEN deadlock_detected OR serialization_failure OR lock_not_available THEN RAISE;
    WHEN OTHERS THEN PERFORM app.audience_count_invalidate('maintenance failed: ' || SQLSTATE || ' ' || SQLERRM);
  END;
  RETURN NULL;
END $$;

-- TRUNCATE has no tenant context and only the owner can do it: every workspace becomes INVALID.
-- Owner-owned (BYPASSRLS) because it must reach every workspace.
CREATE FUNCTION app.audience_count_trg_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE public.audience_count_state
     SET state = 'invalid', generation = generation + 1, reason = 'TRUNCATE ' || TG_TABLE_NAME,
         rebuild_token = NULL, rebuild_lease_until = NULL, changed_at = now();
  RETURN NULL;
END $$;

-- A new workspace is empty, hence its bitmap is valid. Owner-owned: the new workspace is not the session's context.
CREATE FUNCTION app.audience_count_trg_workspace_ins() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO public.audience_count_state (org_id, workspace_id, state, reason) VALUES (NEW.org_id, NEW.id, 'valid', 'new empty workspace');
  RETURN NULL;
END $$;

-- ─── 6. Verification and reconciliation ─────────────────────────────────────────────────────────────────────────
-- Fresh chunks derived from the source tables of the CURRENT workspace (RLS-confined reads).
CREATE FUNCTION app.audience_count_fresh_source() RETURNS TABLE (source_id uuid, chunk bigint, bits bit varying)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT x.src, x.chunk, bit_or(set_bit(repeat('0', 4096)::bit varying, x.off, 1)) FROM (
    SELECT m.list_id AS src, s.seq / 4096 AS chunk, (s.seq % 4096)::int AS off
      FROM public.list_memberships m JOIN public.audience_count_contact_seq s ON s.contact_id = m.contact_id
    UNION ALL
    SELECT m.tag_id, s.seq / 4096, (s.seq % 4096)::int
      FROM public.contact_tags m JOIN public.audience_count_contact_seq s ON s.contact_id = m.contact_id) x
  GROUP BY 1, 2
$$;
CREATE FUNCTION app.audience_count_fresh_dead() RETURNS TABLE (chunk bigint, bits bit varying)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.seq / 4096, bit_or(set_bit(repeat('0', 4096)::bit varying, (s.seq % 4096)::int, 1))
    FROM public.contacts c JOIN public.audience_count_contact_seq s ON s.contact_id = c.id
   WHERE c.deleted_at IS NOT NULL OR c.erased_at IS NOT NULL
   GROUP BY 1
$$;
-- Stored (non-zero) chunks = fresh chunks, and every contact has a position: ONE statement, one MVCC snapshot,
-- no locks. Detects wrong bits, missing and extra chunk rows, stale chunks, stale dead bits, missing positions.
CREATE FUNCTION app.audience_count_verify() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET work_mem = '128MB' AS $$
  SELECT jsonb_build_object(
    'sourceDiff', (SELECT count(*) FROM app.audience_count_fresh_source() f
                   FULL JOIN (SELECT source_id, chunk, bits FROM public.audience_count_source_chunks WHERE bit_count(bits) > 0) s
                   USING (source_id, chunk) WHERE f.bits IS DISTINCT FROM s.bits),
    'deadDiff', (SELECT count(*) FROM app.audience_count_fresh_dead() f
                 FULL JOIN (SELECT chunk, bits FROM public.audience_count_dead_chunks WHERE bit_count(bits) > 0) s
                 USING (chunk) WHERE f.bits IS DISTINCT FROM s.bits),
    'positionsMissing', (SELECT count(*) FROM public.contacts c
                         WHERE NOT EXISTS (SELECT 1 FROM public.audience_count_contact_seq s WHERE s.contact_id = c.id)))
$$;

-- Reconciliation of the CURRENT workspace: acts on VALID bitmaps only (a rebuilding or invalid one is already not
-- served). A difference marks it INVALID. The outcome and time are recorded either way.
CREATE FUNCTION app.audience_count_reconcile() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET work_mem = '128MB' AS $$
DECLARE st text; g bigint; v jsonb; ok boolean; t0 timestamptz := clock_timestamp();
BEGIN
  SELECT state, generation INTO st, g FROM public.audience_count_state WHERE workspace_id = app.current_workspace_id();
  IF st IS DISTINCT FROM 'valid' THEN RETURN jsonb_build_object('skipped', coalesce(st, 'missing')); END IF;
  v := app.audience_count_verify();
  ok := (v->>'sourceDiff')::bigint = 0 AND (v->>'deadDiff')::bigint = 0 AND (v->>'positionsMissing')::bigint = 0;
  v := v || jsonb_build_object('ok', ok, 'ms', round(extract(epoch FROM clock_timestamp() - t0) * 1000));
  IF NOT ok THEN
    PERFORM app.audience_count_invalidate('reconciliation found differences ' || v::text);
  END IF;
  -- record only if the generation did not move meanwhile (no lost invalidation)
  UPDATE public.audience_count_state SET last_reconciled_at = now(), last_reconcile_result = v
   WHERE workspace_id = app.current_workspace_id() AND generation = CASE WHEN ok THEN g ELSE generation END;
  RETURN v;
END $$;

-- ─── 7. Online rebuild (single rebuilder, per-chunk short transactions, generation compare-and-set) ─────────────
-- R1: take the lease (fails if another live lease exists) and enter REBUILDING with a new generation.
CREATE FUNCTION app.audience_count_begin_rebuild(p_token uuid, p_lease_seconds int) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE g bigint;
BEGIN
  IF app.current_workspace_id() IS NULL THEN RAISE EXCEPTION 'rebuild needs a workspace context' USING ERRCODE = 'insufficient_privilege'; END IF;
  INSERT INTO public.audience_count_state AS s (org_id, workspace_id, state, reason, rebuild_token, rebuild_lease_until)
  VALUES (app.current_org_id(), app.current_workspace_id(), 'rebuilding', 'rebuild started', p_token, now() + make_interval(secs => p_lease_seconds))
  ON CONFLICT (workspace_id) DO UPDATE
     SET state = 'rebuilding', generation = s.generation + 1, reason = 'rebuild started',
         rebuild_token = EXCLUDED.rebuild_token, rebuild_lease_until = EXCLUDED.rebuild_lease_until, changed_at = now()
   WHERE s.rebuild_token IS NULL OR s.rebuild_lease_until < now() OR s.rebuild_token = EXCLUDED.rebuild_token
  RETURNING generation INTO g;
  RETURN g; -- NULL: another rebuilder holds a live lease
END $$;

-- Lease renewal; FALSE means this rebuild was superseded (invalidated or taken over) and must stop.
CREATE FUNCTION app.audience_count_renew_lease(p_token uuid, p_generation bigint, p_lease_seconds int) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH u AS (
    UPDATE public.audience_count_state SET rebuild_lease_until = now() + make_interval(secs => p_lease_seconds)
     WHERE workspace_id = app.current_workspace_id() AND state = 'rebuilding' AND generation = p_generation AND rebuild_token = p_token
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

-- R2a: does any contact of this workspace lack a position? One hash anti-join (sequential reads), so a rebuild after
-- installation can skip the keyset pass below (MEASURED at 5M: the pass took 955 s with every contact positioned).
-- Contacts created meanwhile get their position from the insert trigger; verification re-checks before VALID.
CREATE FUNCTION app.audience_count_positions_missing() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET enable_nestloop = off SET work_mem = '128MB' AS $$
  SELECT EXISTS (SELECT 1 FROM public.contacts c
                  WHERE NOT EXISTS (SELECT 1 FROM public.audience_count_contact_seq s WHERE s.contact_id = c.id))
$$;

-- R2: positions for contacts that have none (contacts created before installation). Keyset pass over the
-- (org_id, workspace_id, id) index: each call handles the next p_limit contacts after p_after and returns the last id
-- it covered (NULL when the pass is complete). Contacts created meanwhile get their position from the insert trigger.
CREATE FUNCTION app.audience_count_fill_positions(p_after uuid, p_limit int) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET plan_cache_mode = force_custom_plan AS $$
DECLARE last uuid;
BEGIN
  SELECT x.id INTO last FROM (
    SELECT id FROM public.contacts
     WHERE org_id = app.current_org_id() AND workspace_id = app.current_workspace_id() AND (p_after IS NULL OR id > p_after)
     ORDER BY id LIMIT p_limit) x
   ORDER BY x.id DESC LIMIT 1;
  IF last IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.audience_count_contact_seq (org_id, workspace_id, contact_id, seq)
  SELECT c.org_id, c.workspace_id, c.id, nextval('app.audience_count_seq_gen') FROM (
    SELECT org_id, workspace_id, id FROM public.contacts c
     WHERE org_id = app.current_org_id() AND workspace_id = app.current_workspace_id()
       AND (p_after IS NULL OR id > p_after) AND id <= last
       AND NOT EXISTS (SELECT 1 FROM public.audience_count_contact_seq s WHERE s.contact_id = c.id)
     ORDER BY id) c
  ON CONFLICT DO NOTHING;
  RETURN last;
END $$;

-- R3: what to repair: every position chunk holding a position of this workspace ∪ every chunk with stored non-zero
-- bits (stale rows must be zeroed). Chunk numbers only; no bits built.
CREATE FUNCTION app.audience_count_repair_list() RETURNS TABLE (chunk bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET work_mem = '128MB' AS $$
  SELECT p.seq / 4096 FROM public.audience_count_contact_seq p
  UNION SELECT s.chunk FROM public.audience_count_source_chunks s WHERE bit_count(s.bits) > 0
  UNION SELECT d.chunk FROM public.audience_count_dead_chunks d WHERE bit_count(d.bits) > 0
  ORDER BY 1
$$;

-- Exclusive chunk lock without queueing ahead of writers: p_wait_ms = 0 → try once; > 0 → wait at most that long.
CREATE FUNCTION app.audience_count_try_lock(p_key bigint, p_wait_ms int) RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_wait_ms <= 0 THEN RETURN pg_try_advisory_xact_lock(p_key); END IF;
  PERFORM set_config('lock_timeout', p_wait_ms || 'ms', true);
  BEGIN
    PERFORM pg_advisory_xact_lock(p_key);
    PERFORM set_config('lock_timeout', '0', true);
    RETURN true;
  EXCEPTION WHEN lock_not_available THEN
    PERFORM set_config('lock_timeout', '0', true);
    RETURN false;
  END;
END $$;

-- R4: repair ONE position chunk (≤ 4,096 positions) in the caller's short transaction: every (source, chunk) row and
-- the dead row of that chunk. FALSE = busy (skipped; the driver retries it in a later pass).
--  1. Candidate sources: stored non-zero rows of the chunk ∪ sources of the chunk's members (read without locks).
--  2. Exclusive locks on the dead key and on every candidate (source, chunk) key, ascending, each by try-lock or a
--     bounded wait (p_wait_ms, kept below deadlock_timeout) — never queued ahead of writers; all or nothing.
--  3. A NEW statement (READ COMMITTED) then sees every committed write to these rows; only LOCKED rows are written, so
--     no in-flight writer's delta can be overwritten. A source that was absent in step 1 had stored zero = truth then,
--     and every later change reaches it through the commutative triggers.
-- One probe pass over the chunk's positions through the (workspace_id, contact_id) membership indexes serves every
-- source; hash and merge joins are disabled and plans are custom (a generic plan for the variable bounds was MEASURED
-- at > 10 s per chunk), so the cost is per chunk, never per source size (a hashed sub-plan read
-- the whole source per chunk: quadratic, MEASURED 0.4 s per (source, chunk) at 1M under writers).
CREATE FUNCTION app.audience_count_repair_chunk(p_chunk bigint, p_wait_ms int) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET enable_hashjoin = off SET enable_mergejoin = off
  SET plan_cache_mode = force_custom_plan AS $$
DECLARE
  ws uuid := app.current_workspace_id(); org uuid := app.current_org_id();
  z bit varying := repeat('0', 4096)::bit varying; srcs uuid[]; src uuid; lo bigint := p_chunk * 4096; hi bigint := (p_chunk + 1) * 4096;
BEGIN
  IF ws IS NULL THEN RAISE EXCEPTION 'repair needs a workspace context' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT coalesce(array_agg(x.src ORDER BY x.src), '{}') INTO srcs FROM (
    SELECT c.source_id AS src FROM public.audience_count_source_chunks c WHERE c.workspace_id = ws AND c.chunk = p_chunk AND bit_count(c.bits) > 0
    UNION SELECT m.list_id FROM public.audience_count_contact_seq p JOIN public.list_memberships m ON m.workspace_id = ws AND m.contact_id = p.contact_id
           WHERE p.seq >= lo AND p.seq < hi
    UNION SELECT m.tag_id FROM public.audience_count_contact_seq p JOIN public.contact_tags m ON m.workspace_id = ws AND m.contact_id = p.contact_id
           WHERE p.seq >= lo AND p.seq < hi) x;
  IF NOT app.audience_count_try_lock(app.audience_count_dead_key(ws, p_chunk), p_wait_ms) THEN RETURN false; END IF;
  FOREACH src IN ARRAY srcs LOOP
    IF NOT app.audience_count_try_lock(app.audience_count_source_key(src, p_chunk), p_wait_ms) THEN RETURN false; END IF;
  END LOOP;

  INSERT INTO public.audience_count_source_chunks AS c (org_id, workspace_id, source_id, chunk, bits)
  SELECT org, ws, x.src, p_chunk, coalesce(f.b, z) FROM unnest(srcs) AS x(src)
    LEFT JOIN (SELECT y.src, bit_or(set_bit(z, y.off, 1)) AS b FROM (
                 SELECT m.list_id AS src, (p.seq % 4096)::int AS off FROM public.audience_count_contact_seq p
                   JOIN public.list_memberships m ON m.workspace_id = ws AND m.contact_id = p.contact_id WHERE p.seq >= lo AND p.seq < hi
                 UNION ALL
                 SELECT m.tag_id, (p.seq % 4096)::int FROM public.audience_count_contact_seq p
                   JOIN public.contact_tags m ON m.workspace_id = ws AND m.contact_id = p.contact_id WHERE p.seq >= lo AND p.seq < hi) y
               GROUP BY y.src) f ON f.src = x.src
  ON CONFLICT (workspace_id, source_id, chunk) DO UPDATE SET bits = EXCLUDED.bits;

  INSERT INTO public.audience_count_dead_chunks AS d (org_id, workspace_id, chunk, bits)
  SELECT org, ws, p_chunk, t.b FROM (
    SELECT coalesce(bit_or(set_bit(z, (p.seq % 4096)::int, 1)), z) AS b FROM public.audience_count_contact_seq p
      JOIN public.contacts c ON c.id = p.contact_id
     WHERE p.seq >= lo AND p.seq < hi AND (c.deleted_at IS NOT NULL OR c.erased_at IS NOT NULL)) t
   WHERE bit_count(t.b) > 0 OR EXISTS (SELECT 1 FROM public.audience_count_dead_chunks e WHERE e.workspace_id = ws AND e.chunk = p_chunk)
  ON CONFLICT (workspace_id, chunk) DO UPDATE SET bits = EXCLUDED.bits;
  RETURN true;
END $$;

-- R5: verify the whole bitmap, then publish VALID only if verification passed AND the generation and lease token are
-- unchanged since R1 (any invalidation or takeover in between makes the compare-and-set update 0 rows).
CREATE FUNCTION app.audience_count_finish_rebuild(p_token uuid, p_generation bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET work_mem = '128MB' AS $$
DECLARE v jsonb := app.audience_count_verify(); ok boolean; n int;
BEGIN
  ok := (v->>'sourceDiff')::bigint = 0 AND (v->>'deadDiff')::bigint = 0 AND (v->>'positionsMissing')::bigint = 0;
  IF ok THEN
    UPDATE public.audience_count_state
       SET state = 'valid', reason = 'rebuilt and verified', rebuild_token = NULL, rebuild_lease_until = NULL,
           changed_at = now(), last_reconciled_at = now(), last_reconcile_result = v
     WHERE workspace_id = app.current_workspace_id() AND state = 'rebuilding' AND generation = p_generation AND rebuild_token = p_token;
  ELSE
    UPDATE public.audience_count_state
       SET state = 'invalid', generation = generation + 1, reason = left('rebuild verification failed ' || v::text, 500),
           rebuild_token = NULL, rebuild_lease_until = NULL, changed_at = now()
     WHERE workspace_id = app.current_workspace_id() AND generation = p_generation AND rebuild_token = p_token;
  END IF;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN v || jsonb_build_object('ok', ok, 'published', ok AND n = 1, 'superseded', n = 0);
END $$;

-- ─── 8. Garbage collection of all-zero chunks (e.g. after list/tag deletion) ────────────────────────────────────
-- Each candidate is deleted under its exclusive chunk lock (try-lock: never queues ahead of writers) after
-- re-checking that it is still all-zero. A zero row carries no information, so deletion never changes a count.
CREATE FUNCTION app.audience_count_gc(p_limit int) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r record; deleted int := 0; busy int := 0; n int;
BEGIN
  FOR r IN SELECT source_id, chunk FROM public.audience_count_source_chunks WHERE bit_count(bits) = 0 ORDER BY 1, 2 LIMIT p_limit LOOP
    IF pg_try_advisory_xact_lock(app.audience_count_source_key(r.source_id, r.chunk)) THEN
      DELETE FROM public.audience_count_source_chunks
       WHERE workspace_id = app.current_workspace_id() AND source_id = r.source_id AND chunk = r.chunk AND bit_count(bits) = 0;
      GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted + n;
    ELSE busy := busy + 1; END IF;
  END LOOP;
  FOR r IN SELECT chunk FROM public.audience_count_dead_chunks WHERE bit_count(bits) = 0 ORDER BY 1 LIMIT p_limit LOOP
    IF pg_try_advisory_xact_lock(app.audience_count_dead_key(app.current_workspace_id(), r.chunk)) THEN
      DELETE FROM public.audience_count_dead_chunks WHERE workspace_id = app.current_workspace_id() AND chunk = r.chunk AND bit_count(bits) = 0;
      GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted + n;
    ELSE busy := busy + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('deleted', deleted, 'busy', busy);
END $$;

-- ─── 9. Discovery for the maintenance job: workspace pairs only (like app.workspaces_with_snapshot_cleanup) ─────
-- Workspaces whose bitmap is not valid (and not held by a live rebuild lease), or valid but not reconciled since
-- p_reconcile_before. Owner-owned (BYPASSRLS) because discovery looks across tenants; returns ids and state only.
CREATE FUNCTION app.audience_count_workspaces_due(p_reconcile_before timestamptz, p_limit int)
RETURNS TABLE (org_id uuid, workspace_id uuid, state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.org_id, s.workspace_id, s.state FROM audience_count_state s
   WHERE (s.state <> 'valid' AND (s.rebuild_lease_until IS NULL OR s.rebuild_lease_until < now()))
      OR (s.state = 'valid' AND (s.last_reconciled_at IS NULL OR s.last_reconciled_at < p_reconcile_before))
   ORDER BY (s.state = 'valid'), s.last_reconciled_at NULLS FIRST, s.changed_at
   LIMIT p_limit
$$;

-- ─── 10. Ownership and EXECUTE (no PUBLIC execute on anything) ──────────────────────────────────────────────────
-- workeasy_owner hands the maintenance functions to workeasy_audience_count. ALTER OWNER requires the new owner to
-- have CREATE on the schema; it is granted for this step only and revoked right after.
GRANT CREATE ON SCHEMA app TO workeasy_audience_count;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'audience_count_mask(int[])', 'audience_count_source_key(uuid, bigint)', 'audience_count_dead_key(uuid, bigint)',
    'audience_count_invalidate(text)', 'audience_count_is_valid()', 'audience_count_trg_members()', 'audience_count_trg_contact_ins()',
    'audience_count_trg_contact_live()', 'audience_count_fresh_source()', 'audience_count_fresh_dead()',
    'audience_count_verify()', 'audience_count_reconcile()', 'audience_count_begin_rebuild(uuid, int)',
    'audience_count_renew_lease(uuid, bigint, int)', 'audience_count_fill_positions(uuid, int)', 'audience_count_positions_missing()', 'audience_count_repair_list()',
    'audience_count_try_lock(bigint, int)', 'audience_count_repair_chunk(bigint, int)', 'audience_count_finish_rebuild(uuid, bigint)', 'audience_count_gc(int)']
  LOOP
    EXECUTE format('ALTER FUNCTION app.%s OWNER TO workeasy_audience_count', f);
    EXECUTE format('REVOKE ALL ON FUNCTION app.%s FROM PUBLIC', f);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA app FROM workeasy_audience_count;
REVOKE ALL ON FUNCTION app.audience_count_trg_truncate(), app.audience_count_trg_workspace_ins(),
  app.audience_count_trg_invalidate_rows(), app.audience_count_invalidate_workspaces(uuid[], text),
  app.audience_count_workspaces_due(timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.audience_count_invalidate_workspaces(uuid[], text) TO workeasy_audience_count;
-- Internal helpers: callable by the maintenance role (as owner) only.
-- Runtime role: the maintenance entry points, all confined to the session's workspace.
GRANT EXECUTE ON FUNCTION
  app.audience_count_reconcile(), app.audience_count_begin_rebuild(uuid, int), app.audience_count_renew_lease(uuid, bigint, int),
  app.audience_count_fill_positions(uuid, int), app.audience_count_positions_missing(), app.audience_count_repair_list(), app.audience_count_repair_chunk(bigint, int), app.audience_count_finish_rebuild(uuid, bigint), app.audience_count_gc(int),
  app.audience_count_workspaces_due(timestamptz, int)
TO workeasy_app;

-- ─── 11. Triggers: ENABLE ALWAYS, so they also fire for replica-mode sessions (e.g. logical replication apply) ─────
CREATE TRIGGER audience_count_lm_ins AFTER INSERT ON "list_memberships" REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.audience_count_trg_members('list_id');
CREATE TRIGGER audience_count_lm_del AFTER DELETE ON "list_memberships" REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.audience_count_trg_members('list_id');
CREATE TRIGGER audience_count_ct_ins AFTER INSERT ON "contact_tags" REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.audience_count_trg_members('tag_id');
CREATE TRIGGER audience_count_ct_del AFTER DELETE ON "contact_tags" REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.audience_count_trg_members('tag_id');
CREATE TRIGGER audience_count_contact_ins AFTER INSERT ON "contacts" REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.audience_count_trg_contact_ins();
CREATE TRIGGER audience_count_contact_live AFTER UPDATE OF deleted_at, erased_at ON "contacts"
  FOR EACH ROW WHEN ((OLD.deleted_at IS NOT NULL OR OLD.erased_at IS NOT NULL) IS DISTINCT FROM (NEW.deleted_at IS NOT NULL OR NEW.erased_at IS NOT NULL))
  EXECUTE FUNCTION app.audience_count_trg_contact_live();
CREATE TRIGGER audience_count_truncate_contacts AFTER TRUNCATE ON "contacts" FOR EACH STATEMENT EXECUTE FUNCTION app.audience_count_trg_truncate();
CREATE TRIGGER audience_count_truncate_lm AFTER TRUNCATE ON "list_memberships" FOR EACH STATEMENT EXECUTE FUNCTION app.audience_count_trg_truncate();
CREATE TRIGGER audience_count_truncate_ct AFTER TRUNCATE ON "contact_tags" FOR EACH STATEMENT EXECUTE FUNCTION app.audience_count_trg_truncate();
CREATE TRIGGER audience_count_lm_upd AFTER UPDATE ON "list_memberships" REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.audience_count_trg_invalidate_rows();
CREATE TRIGGER audience_count_ct_upd AFTER UPDATE ON "contact_tags" REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.audience_count_trg_invalidate_rows();
CREATE TRIGGER audience_count_contact_del AFTER DELETE ON "contacts" REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION app.audience_count_trg_invalidate_rows();
CREATE TRIGGER audience_count_workspace_ins AFTER INSERT ON "workspaces" FOR EACH ROW EXECUTE FUNCTION app.audience_count_trg_workspace_ins();
ALTER TABLE "list_memberships" ENABLE ALWAYS TRIGGER audience_count_lm_ins, ENABLE ALWAYS TRIGGER audience_count_lm_del,
  ENABLE ALWAYS TRIGGER audience_count_lm_upd, ENABLE ALWAYS TRIGGER audience_count_truncate_lm;
ALTER TABLE "contact_tags" ENABLE ALWAYS TRIGGER audience_count_ct_ins, ENABLE ALWAYS TRIGGER audience_count_ct_del,
  ENABLE ALWAYS TRIGGER audience_count_ct_upd, ENABLE ALWAYS TRIGGER audience_count_truncate_ct;
ALTER TABLE "contacts" ENABLE ALWAYS TRIGGER audience_count_contact_ins, ENABLE ALWAYS TRIGGER audience_count_contact_live,
  ENABLE ALWAYS TRIGGER audience_count_contact_del, ENABLE ALWAYS TRIGGER audience_count_truncate_contacts;
ALTER TABLE "workspaces" ENABLE ALWAYS TRIGGER audience_count_workspace_ins;

-- ─── 12. Every existing workspace starts INVALID (exact count until rebuilt and verified) ───────────────────────
INSERT INTO audience_count_state (org_id, workspace_id, state, reason)
SELECT org_id, id, 'invalid', 'installed; awaiting first verified rebuild' FROM workspaces
ON CONFLICT (workspace_id) DO NOTHING;
