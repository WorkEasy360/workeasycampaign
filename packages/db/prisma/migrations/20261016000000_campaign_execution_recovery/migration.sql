-- Phase 6.9 (Gate G3, test mode only; docs/architecture/phase-6-campaign-engine.md §22) — execution recovery discovery.
-- Part A (prisma migrate diff): empty — no schema change. Part B (hand-written): one discovery function.
--
-- Contract §6.4 / §11: the recovery sweep must find, ACROSS tenants, the workspaces that have execution work to recover,
-- then process each workspace inside withTenant (RLS) only. Like app.workspaces_with_snapshot_cleanup (decision J) it is
-- SECURITY DEFINER (the owner bypasses RLS for discovery) and returns (org_id, workspace_id) pairs ONLY — never
-- execution, campaign, recipient or contact ids. A workspace qualifies when it has:
--   (a) a started execution (materializing / delivering) whose lease is absent or expired (crashed or stalled worker);
--   (b) a send-now execution still pending after p_stale_before (its start job was lost; recovery, not scheduling —
--       executions scheduled for a later time are started by the Phase 8 scheduler, not here);
--   (c) a cancelled execution with recipients not yet final (cancel follow-up interrupted);
--   (d) a releasable execution (materialized or terminal, started) whose snapshot release did not complete.
CREATE FUNCTION app.workspaces_with_campaign_recovery(p_stale_before timestamptz)
RETURNS TABLE (org_id uuid, workspace_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT e.org_id, e.workspace_id
  FROM campaign_executions e
  WHERE (e.status IN ('materializing', 'delivering') AND (e.lease_until IS NULL OR e.lease_until < now()))
     OR (e.status = 'pending' AND e.send_at <= p_stale_before
         AND EXISTS (SELECT 1 FROM campaign_versions v WHERE v.id = e.version_id AND v.reason = 'sent_now'))
     OR (e.status = 'cancelled'
         AND EXISTS (SELECT 1 FROM campaign_recipients r WHERE r.execution_id = e.id AND r.status IN ('pending', 'queued', 'sending')))
     OR ((e.materialized_at IS NOT NULL OR e.status IN ('completed', 'cancelled', 'failed'))
         AND e.started_at IS NOT NULL AND e.snapshot_released_at IS NULL)
$$;
REVOKE ALL ON FUNCTION app.workspaces_with_campaign_recovery(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.workspaces_with_campaign_recovery(timestamptz) TO workeasy_app;
