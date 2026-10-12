-- Campaign analytics v1 (docs/architecture/analytics-tracking.md §4): completed runs of a workspace by completion time.
-- Partial: only completed runs are aggregated, so the index stays proportional to finished work.
CREATE INDEX "campaign_executions_workspace_completed_idx" ON "campaign_executions" ("workspace_id", "completed_at") WHERE status = 'completed';
