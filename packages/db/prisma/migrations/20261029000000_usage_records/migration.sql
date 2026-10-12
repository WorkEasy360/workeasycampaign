-- Usage metering (Phase 7.13; docs/architecture/ai-billing-readiness.md §2, contract usage.record.v1).
-- usage_records is an append-only ledger of usage FACTS emitted by the owning context, idempotent on record_id
-- (e.g. "campaign.executions:<execution id>", "templates.active:<workspace>:<day>"). A billing context aggregates it per
-- organization and period later; no price, plan or quota lives here. Written in the same transaction as the fact it
-- meters (exactly once, never lost); the runtime role may only insert and read — no update, no delete.

CREATE TABLE "usage_records" (
    "record_id" TEXT NOT NULL,
    "org_id" UUID NOT NULL,
    "workspace_id" UUID,
    "meter" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("record_id"),
    CONSTRAINT usage_records_record_id_chk CHECK (char_length(record_id) BETWEEN 8 AND 200),
    CONSTRAINT usage_records_meter_chk CHECK (meter IN ('contacts.active', 'campaign.executions', 'messages.sent', 'templates.active', 'storage.bytes', 'ai.tokens')),
    CONSTRAINT usage_records_quantity_chk CHECK (quantity >= 0)
);
CREATE INDEX "usage_records_org_meter_at_idx" ON "usage_records"("org_id", "meter", "at");
REVOKE ALL ON "usage_records" FROM PUBLIC;
GRANT SELECT, INSERT ON "usage_records" TO workeasy_app;
ALTER TABLE "usage_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "usage_records" FORCE ROW LEVEL SECURITY;
-- Organization-owned: read at organization level; written inside a workspace transaction (or with no workspace).
CREATE POLICY usage_records_org ON "usage_records" FOR ALL
  USING (org_id = app.current_org_id())
  WITH CHECK (org_id = app.current_org_id() AND (workspace_id IS NULL OR workspace_id = app.current_workspace_id()));

-- Daily gauge snapshots enumerate active workspaces across organizations (each is then measured inside withTenant).
CREATE FUNCTION app.usage_snapshot_workspaces(p_after uuid, p_limit int)
RETURNS TABLE (org_id uuid, workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT w.org_id, w.id FROM workspaces w JOIN organizations o ON o.id = w.org_id
   WHERE o.status = 'active' AND w.status = 'active' AND (p_after IS NULL OR w.id > p_after)
   ORDER BY w.id LIMIT least(greatest(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION app.usage_snapshot_workspaces(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.usage_snapshot_workspaces(uuid, int) TO workeasy_app;
