-- Audience Resolution v1: D2 snapshot storage and resolution performance (Phase 6.3 Gate G2 capture gate;
-- docs/audit/phase-6.3-performance-remediation.md §14, docs/audit/phase-6.3-g2-closure.md).
-- Additive and non-destructive:
--   * one new Audience-owned table, audience_snapshot_chunks (captured members as sorted 1,000-id chunks),
--     with the same composite FK, forced workspace RLS and immutability as audience_snapshot_members;
--   * existing member rows are copied into chunks; audience_snapshot_members is kept and no longer written
--     (a later migration may drop it);
--   * the RLS policies of the Audience tables are rewritten in InitPlan form: the IDENTICAL predicate, written so it
--     is evaluated once per statement instead of once per row;
--   * one partial index over the (few) deleted or erased contacts.
-- No existing column, grant or constraint is changed or removed.
-- ═══ Part A: generated (prisma migrate diff) ═══

-- CreateTable
CREATE TABLE "audience_snapshot_chunks" (
    "org_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "chunk_no" INTEGER NOT NULL,
    "first_contact" UUID NOT NULL,
    "last_contact" UUID NOT NULL,
    "contact_ids" UUID[],

    CONSTRAINT "audience_snapshot_chunks_pkey" PRIMARY KEY ("snapshot_id","chunk_no")
);

-- AddForeignKey
ALTER TABLE "audience_snapshot_chunks" ADD CONSTRAINT "audience_snapshot_chunks_org_id_workspace_id_snapshot_id_fkey" FOREIGN KEY ("org_id", "workspace_id", "snapshot_id") REFERENCES "audience_snapshots"("org_id", "workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══ Part B: hand-written ═══

-- ─── 1. Constraints: a chunk is a non-empty, ascending slice of at most 1,000 ids; chunk numbers are dense from 0 ──
-- (5,000,000 / 1,000 = 5,000 chunks at the frozen capture limit.)
ALTER TABLE "audience_snapshot_chunks"
  ALTER COLUMN contact_ids SET NOT NULL,
  ADD CONSTRAINT audience_snapshot_chunks_size_chk CHECK (cardinality(contact_ids) BETWEEN 1 AND 1000),
  ADD CONSTRAINT audience_snapshot_chunks_no_chk CHECK (chunk_no BETWEEN 0 AND 4999),
  ADD CONSTRAINT audience_snapshot_chunks_bounds_chk
    CHECK (first_contact = contact_ids[1] AND last_contact = contact_ids[cardinality(contact_ids)] AND first_contact <= last_contact);

-- ─── 2. Immutability (defence in depth on top of the grants; also binds the owner role) ─────────────────────────
CREATE TRIGGER audience_snapshot_chunks_no_update BEFORE UPDATE ON "audience_snapshot_chunks"
  FOR EACH ROW EXECUTE FUNCTION app.reject_update();

-- ─── 3. Privileges for workeasy_app: same shape as audience_snapshot_members (decision I). Nothing for reporting/identity
GRANT SELECT, INSERT, DELETE ON "audience_snapshot_chunks" TO workeasy_app;

-- ─── 4. Row-level security: workspace-owned, forced ────────────────────────────────────────────────────────────
ALTER TABLE public.audience_snapshot_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audience_snapshot_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY audience_snapshot_chunks_workspace ON public.audience_snapshot_chunks FOR ALL
  USING (org_id = (SELECT app.current_org_id()) AND workspace_id = (SELECT app.current_workspace_id()))
  WITH CHECK (org_id = (SELECT app.current_org_id()) AND workspace_id = (SELECT app.current_workspace_id()));

-- ─── 5. InitPlan form of the existing Audience policies (identical predicate; remediation §7) ───────────────────
-- `app.current_org_id()` expands to current_setting(...) and was evaluated for every scanned row; as an uncorrelated
-- sub-select it is evaluated once per statement. The rows a role can see or write are exactly the same.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contacts', 'list_memberships', 'contact_tags', 'lists', 'tags', 'audience_snapshots', 'audience_snapshot_members']
  LOOP
    EXECUTE format(
      'ALTER POLICY %I ON public.%I
         USING (org_id = (SELECT app.current_org_id()) AND workspace_id = (SELECT app.current_workspace_id()))
         WITH CHECK (org_id = (SELECT app.current_org_id()) AND workspace_id = (SELECT app.current_workspace_id()))',
      t || '_workspace', t);
  END LOOP;
END $$;

-- ─── 6. Non-live contacts (remediation §8): set-algebra resolution subtracts them; usually a tiny fraction ───────
-- Plain CREATE INDEX (Prisma runs the migration in a transaction): takes a SHARE lock on contacts for the build,
-- blocking writes (not reads) for its duration. On a large existing table create it beforehand with
-- `CREATE INDEX CONCURRENTLY contacts_non_live_idx ...` (identical definition); this statement is then a no-op.
CREATE INDEX IF NOT EXISTS contacts_non_live_idx ON public.contacts (workspace_id, id) INCLUDE (org_id)
  WHERE deleted_at IS NOT NULL OR erased_at IS NOT NULL;

-- ─── 7. Existing captured members → chunks (ascending contact id, 1,000 per chunk). Run as the owner, per snapshot.
INSERT INTO audience_snapshot_chunks (org_id, workspace_id, snapshot_id, chunk_no, first_contact, last_contact, contact_ids)
SELECT g.org_id, g.workspace_id, g.snapshot_id, g.k::int, g.ids[1], g.ids[cardinality(g.ids)], g.ids
FROM (
  SELECT x.org_id, x.workspace_id, x.snapshot_id, x.k, array_agg(x.contact_id ORDER BY x.contact_id) AS ids
  FROM (
    SELECT m.org_id, m.workspace_id, m.snapshot_id, m.contact_id,
           (row_number() OVER (PARTITION BY m.snapshot_id ORDER BY m.contact_id) - 1) / 1000 AS k
    FROM audience_snapshot_members m
  ) x
  GROUP BY x.org_id, x.workspace_id, x.snapshot_id, x.k
) g;
DELETE FROM audience_snapshot_members;
