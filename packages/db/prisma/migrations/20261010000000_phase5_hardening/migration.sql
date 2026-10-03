-- Phase 5 hardening (docs/audit/phase-5-hardening-audit.md).
-- ═══ Part A: generated (prisma migrate diff) ═══

-- AlterTable
ALTER TABLE "consent_states" ADD COLUMN     "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "subject_fingerprint" TEXT;


-- ═══ Part B: security (hand-written) ═══

-- ─── 1. Backfill the new projection columns from the event each projection points at ──────────────────────────
-- recorded_at: server time of that event. subject_fingerprint: the address that event applied to.
UPDATE consent_states s
SET recorded_at = e.recorded_at, subject_fingerprint = e.subject_fingerprint
FROM consent_events e
WHERE e.id = s.last_event_id;

GRANT UPDATE (recorded_at, subject_fingerprint) ON "consent_states" TO workeasy_app;

-- ─── 2. Evidence timestamps cannot be in the future (finding H-1) ──────────────────────────────────────────────
-- occurred_at may lie in the past (paper or verbal consent recorded later) but never after it was recorded.
-- A small allowance absorbs clock skew between the API and the database.
ALTER TABLE "consent_events" ADD CONSTRAINT consent_events_occurred_not_future_chk
  CHECK (occurred_at <= recorded_at + interval '5 minutes');

-- ─── 3. Retention purge measured from SERVER time (finding H-1) ────────────────────────────────────────────────
-- Previously the withdrawal age came from consent_states.changed_at, which is the client-supplied occurredAt: a
-- withdrawal "dated" years ago became purgeable at once, so a user could destroy a contact's consent history.
-- Now the age is measured from consent_states.recorded_at (server time), and only events recorded no later than
-- the withdrawal itself are eligible. Everything else is unchanged: current-workspace only, no dynamic SQL.
CREATE OR REPLACE FUNCTION app.purge_consent_evidence(p_workspace_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_withdrawal int;
  v_erasure int;
  v_deleted int;
BEGIN
  IF p_workspace_id IS NULL OR p_workspace_id IS DISTINCT FROM app.current_workspace_id() THEN
    RAISE EXCEPTION 'purge is only allowed for the current workspace context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT p.retain_after_withdrawal_days, p.retain_after_erasure_days INTO v_withdrawal, v_erasure
  FROM consent_retention_policies p WHERE p.workspace_id = p_workspace_id;
  IF NOT FOUND THEN
    v_withdrawal := 2190;
    v_erasure := 2190;
  END IF;

  DELETE FROM consent_events e
  WHERE e.workspace_id = p_workspace_id
    AND (
      (v_erasure IS NOT NULL AND EXISTS (
         SELECT 1 FROM contacts c
         WHERE c.id = e.contact_id AND c.workspace_id = p_workspace_id
           AND c.erased_at < now() - make_interval(days => v_erasure)))
      OR (v_withdrawal IS NOT NULL AND e.channel IS NOT NULL AND EXISTS (
         SELECT 1 FROM consent_states s
         WHERE s.contact_id = e.contact_id AND s.channel = e.channel AND s.workspace_id = p_workspace_id
           AND s.state = 'withdrawn'
           AND s.recorded_at < now() - make_interval(days => v_withdrawal)
           AND e.recorded_at <= s.recorded_at))
      OR (v_withdrawal IS NOT NULL AND e.topic_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM contact_topic_preferences tp
         WHERE tp.contact_id = e.contact_id AND tp.topic_id = e.topic_id AND tp.workspace_id = p_workspace_id
           AND tp.status = 'unsubscribed'
           -- changed_at is always server time for topic preferences (no client-supplied timestamp exists).
           AND tp.changed_at < now() - make_interval(days => v_withdrawal)
           AND e.recorded_at <= tp.changed_at))
    );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END $$;
