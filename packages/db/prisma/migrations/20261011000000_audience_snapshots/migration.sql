-- Audience Resolution v1: snapshots (docs/contracts/phase-5-audience.md §9.6; Gate G2 approved at 6.3.0;
-- decisions A–O in docs/architecture/phase-6-campaign-engine.md §15). Additive: two new Audience-owned tables and one
-- discovery function. No existing table, policy or grant is changed.
-- ═══ Part A: generated (prisma migrate diff) ═══

-- CreateTable
CREATE TABLE "audience_snapshots" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "capture_key" TEXT NOT NULL,
    "owner_kind" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "definition" JSONB NOT NULL,
    "definition_hash" TEXT NOT NULL,
    "captured_at" TIMESTAMPTZ(3) NOT NULL,
    "size" INTEGER NOT NULL,
    "released_at" TIMESTAMPTZ(3),
    "release_reason" TEXT,
    "purged_at" TIMESTAMPTZ(3),

    CONSTRAINT "audience_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audience_snapshot_members" (
    "org_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,

    CONSTRAINT "audience_snapshot_members_pkey" PRIMARY KEY ("snapshot_id","contact_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "audience_snapshots_workspace_id_capture_key_key" ON "audience_snapshots"("workspace_id", "capture_key");

-- CreateIndex
CREATE UNIQUE INDEX "audience_snapshots_org_id_workspace_id_id_key" ON "audience_snapshots"("org_id", "workspace_id", "id");

-- AddForeignKey
ALTER TABLE "audience_snapshots" ADD CONSTRAINT "audience_snapshots_org_id_workspace_id_fkey" FOREIGN KEY ("org_id", "workspace_id") REFERENCES "workspaces"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audience_snapshot_members" ADD CONSTRAINT "audience_snapshot_members_org_id_workspace_id_snapshot_id_fkey" FOREIGN KEY ("org_id", "workspace_id", "snapshot_id") REFERENCES "audience_snapshots"("org_id", "workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══ Part B: security (hand-written) ═══

-- ─── 1. Constraints (§9.6) ─────────────────────────────────────────────────────────────────────────────────────
-- No personal data: ids, a hash of selector ids, counts, timestamps and reasons only.
ALTER TABLE "audience_snapshots"
  ADD CONSTRAINT audience_snapshots_capture_key_chk CHECK (char_length(capture_key) BETWEEN 1 AND 200),
  ADD CONSTRAINT audience_snapshots_owner_kind_chk CHECK (owner_kind = 'campaign_execution'),
  ADD CONSTRAINT audience_snapshots_definition_chk CHECK (jsonb_typeof(definition) = 'object'),
  ADD CONSTRAINT audience_snapshots_definition_hash_chk CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT audience_snapshots_size_chk CHECK (size BETWEEN 0 AND 5000000),
  ADD CONSTRAINT audience_snapshots_release_reason_chk
    CHECK (release_reason IN ('materialized', 'cancelled', 'failed', 'orphan_sweep')),
  ADD CONSTRAINT audience_snapshots_release_pair_chk CHECK ((released_at IS NULL) = (release_reason IS NULL)),
  ADD CONSTRAINT audience_snapshots_purge_after_release_chk CHECK (purged_at IS NULL OR released_at IS NOT NULL);

-- ─── 2. Cleanup index: only live working sets (unreleased, or released with the member purge incomplete) ──────
-- Serves listUnreleased, listReleasedUnpurged and the discovery function without scanning snapshot history.
CREATE INDEX audience_snapshots_cleanup_idx ON "audience_snapshots" (workspace_id, owner_kind, captured_at)
  WHERE purged_at IS NULL;

-- ─── 3. Immutability (defence in depth on top of the grants; also binds the owner role) ─────────────────────────
-- After capture nothing changes except released_at, release_reason and purged_at, each from NULL to a value once.
CREATE FUNCTION app.audience_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.capture_key IS DISTINCT FROM OLD.capture_key
     OR NEW.owner_kind IS DISTINCT FROM OLD.owner_kind OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.definition IS DISTINCT FROM OLD.definition OR NEW.definition_hash IS DISTINCT FROM OLD.definition_hash
     OR NEW.captured_at IS DISTINCT FROM OLD.captured_at OR NEW.size IS DISTINCT FROM OLD.size THEN
    RAISE EXCEPTION 'audience snapshots are immutable after capture' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at)
     OR (OLD.release_reason IS NOT NULL AND NEW.release_reason IS DISTINCT FROM OLD.release_reason)
     OR (OLD.purged_at IS NOT NULL AND NEW.purged_at IS DISTINCT FROM OLD.purged_at) THEN
    RAISE EXCEPTION 'audience snapshot lifecycle columns are set once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audience_snapshots_guard BEFORE UPDATE ON "audience_snapshots"
  FOR EACH ROW EXECUTE FUNCTION app.audience_snapshot_guard();
-- Members are inserted by capture and deleted by the release purge; never updated.
CREATE TRIGGER audience_snapshot_members_no_update BEFORE UPDATE ON "audience_snapshot_members"
  FOR EACH ROW EXECUTE FUNCTION app.reject_update();

-- ─── 4. Privileges for workeasy_app (decision I). Nothing for workeasy_reporting / workeasy_identity ────────────
GRANT SELECT, INSERT ON "audience_snapshots" TO workeasy_app;
GRANT UPDATE (released_at, release_reason, purged_at) ON "audience_snapshots" TO workeasy_app;
GRANT SELECT, INSERT, DELETE ON "audience_snapshot_members" TO workeasy_app;

-- ─── 5. Row-level security: workspace-owned (org AND workspace must match the context) ─────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audience_snapshots', 'audience_snapshot_members']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL
         USING (org_id = app.current_org_id() AND workspace_id = app.current_workspace_id())
         WITH CHECK (org_id = app.current_org_id() AND workspace_id = app.current_workspace_id())',
      t || '_workspace', t);
  END LOOP;
END $$;

-- ─── 6. Cleanup discovery (decision J): workspace pairs only, for per-tenant sweeps ────────────────────────────
-- SECURITY DEFINER (owner bypasses RLS) because discovery must look across tenants; it returns nothing but
-- (org_id, workspace_id) pairs — never snapshot ids, keys, owners or contact ids. Each workspace is then processed
-- inside withTenant for that workspace only.
CREATE FUNCTION app.workspaces_with_snapshot_cleanup(p_owner_kind text, p_unreleased_before timestamptz)
RETURNS TABLE (org_id uuid, workspace_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT s.org_id, s.workspace_id
  FROM audience_snapshots s
  WHERE s.owner_kind = p_owner_kind
    AND s.purged_at IS NULL
    AND (s.released_at IS NOT NULL OR s.captured_at < p_unreleased_before)
$$;
REVOKE ALL ON FUNCTION app.workspaces_with_snapshot_cleanup(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.workspaces_with_snapshot_cleanup(text, timestamptz) TO workeasy_app;
