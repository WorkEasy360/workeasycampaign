-- Due discovery for scheduled campaigns (Phase 7.5; contract §9.1 "the Phase 8 due-discovery definer function").
-- Cross-tenant by necessity (a scheduler has no tenant), so SECURITY DEFINER with a pinned search_path, EXECUTE for
-- the runtime role only, and the narrowest result: ids, tenant pair and send time of PENDING executions that are due.
-- Each one is then started by the ordinary start job INSIDE its tenant (RLS), which re-checks status and send time
-- under the campaign → execution lock — a duplicate or late dispatch is a no-op. Uses the partial index
-- campaign_executions_pending_send_at_idx (send_at) WHERE status = 'pending'.

CREATE FUNCTION app.due_campaign_executions(p_now timestamptz, p_limit int)
RETURNS TABLE (org_id uuid, workspace_id uuid, execution_id uuid, send_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT e.org_id, e.workspace_id, e.id, e.send_at
    FROM campaign_executions e
   WHERE e.status = 'pending' AND e.send_at <= p_now
   ORDER BY e.send_at, e.id
   LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
REVOKE ALL ON FUNCTION app.due_campaign_executions(timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.due_campaign_executions(timestamptz, int) TO workeasy_app;
