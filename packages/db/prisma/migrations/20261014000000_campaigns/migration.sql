-- Campaign persistence (Phase 6.5; docs/contracts/phase-6-campaign.md §12; gate approved 2026-10-07, architecture §19).
-- Four Campaign-owned tables. Additive: no existing table, grant or policy changes. Execution PROCESSING is not part of
-- this milestone (6.9, Gate G3): lifecycle commands only create pending executions; nothing creates recipients yet.

-- ═══ Part A: generated (prisma migrate diff) ═══
-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "channel" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'marketing',
    "topic_id" UUID,
    "audience" JSONB NOT NULL DEFAULT '{"include": [], "exclude": []}',
    "sender" JSONB NOT NULL DEFAULT '{"senderIdentityId": null, "fromName": null, "replyTo": null}',
    "messages" JSONB NOT NULL DEFAULT '[]',
    "schedule" JSONB NOT NULL DEFAULT '{"mode": "now", "sendAt": null, "timezone": "UTC"}',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "current_version_id" UUID,
    "current_execution_id" UUID,
    "cloned_from_id" UUID,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_versions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "schema" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_executions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "run_number" INTEGER NOT NULL,
    "run_kind" TEXT NOT NULL DEFAULT 'one_time',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paused_phase" TEXT,
    "send_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "audience_snapshot_id" UUID,
    "captured_at" TIMESTAMPTZ(3),
    "audience_size" INTEGER,
    "materialization_cursor" TEXT,
    "snapshot_released_at" TIMESTAMPTZ(3),
    "materialized_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "planned" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "cancelled" INTEGER NOT NULL DEFAULT 0,
    "unknown" INTEGER NOT NULL DEFAULT 0,
    "skipped_by_reason" JSONB NOT NULL DEFAULT '{}',
    "failure_class" TEXT,
    "failure_code" TEXT,
    "health" TEXT NOT NULL DEFAULT 'ok',
    "last_progress_at" TIMESTAMPTZ(3),
    "lease_owner" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "initiated_by_user_id" UUID,
    "paused_by_user_id" UUID,
    "cancelled_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "campaign_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_recipients" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "address_identity_id" UUID,
    "status" TEXT NOT NULL,
    "reason_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "failure_code" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_owner" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "final_at" TIMESTAMPTZ(3),

    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_workspace_id_status_updated_at_id_idx" ON "campaigns"("workspace_id", "status", "updated_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "campaigns_workspace_id_created_at_id_idx" ON "campaigns"("workspace_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "campaigns_name_idx" ON "campaigns" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_org_id_workspace_id_id_key" ON "campaigns"("org_id", "workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_versions_campaign_id_number_key" ON "campaign_versions"("campaign_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_versions_campaign_id_id_key" ON "campaign_versions"("campaign_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_versions_org_id_workspace_id_id_key" ON "campaign_versions"("org_id", "workspace_id", "id");

-- CreateIndex
CREATE INDEX "campaign_executions_workspace_id_status_send_at_idx" ON "campaign_executions"("workspace_id", "status", "send_at");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_executions_campaign_id_run_number_key" ON "campaign_executions"("campaign_id", "run_number");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_executions_campaign_id_id_key" ON "campaign_executions"("campaign_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_executions_org_id_workspace_id_id_key" ON "campaign_executions"("org_id", "workspace_id", "id");

-- CreateIndex
CREATE INDEX "campaign_recipients_execution_id_status_id_idx" ON "campaign_recipients"("execution_id", "status", "id");

-- CreateIndex
CREATE INDEX "campaign_recipients_workspace_id_contact_id_created_at_idx" ON "campaign_recipients"("workspace_id", "contact_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_execution_id_contact_id_key" ON "campaign_recipients"("execution_id", "contact_id");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_org_id_workspace_id_fkey" FOREIGN KEY ("org_id", "workspace_id") REFERENCES "workspaces"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_org_id_workspace_id_topic_id_fkey" FOREIGN KEY ("org_id", "workspace_id", "topic_id") REFERENCES "topics"("org_id", "workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_org_id_workspace_id_cloned_from_id_fkey" FOREIGN KEY ("org_id", "workspace_id", "cloned_from_id") REFERENCES "campaigns"("org_id", "workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_id_current_version_id_fkey" FOREIGN KEY ("id", "current_version_id") REFERENCES "campaign_versions"("campaign_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_id_current_execution_id_fkey" FOREIGN KEY ("id", "current_execution_id") REFERENCES "campaign_executions"("campaign_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "campaign_versions" ADD CONSTRAINT "campaign_versions_org_id_workspace_id_campaign_id_fkey" FOREIGN KEY ("org_id", "workspace_id", "campaign_id") REFERENCES "campaigns"("org_id", "workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_executions" ADD CONSTRAINT "campaign_executions_org_id_workspace_id_campaign_id_fkey" FOREIGN KEY ("org_id", "workspace_id", "campaign_id") REFERENCES "campaigns"("org_id", "workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_executions" ADD CONSTRAINT "campaign_executions_campaign_id_version_id_fkey" FOREIGN KEY ("campaign_id", "version_id") REFERENCES "campaign_versions"("campaign_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_org_id_workspace_id_execution_id_fkey" FOREIGN KEY ("org_id", "workspace_id", "execution_id") REFERENCES "campaign_executions"("org_id", "workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_org_id_workspace_id_contact_id_fkey" FOREIGN KEY ("org_id", "workspace_id", "contact_id") REFERENCES "contacts"("org_id", "workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══ Part B: hand-written ═══

-- ─── 1. Domain constraints (the database enforces the contract, not only the application) ──────────────────────
ALTER TABLE "campaigns"
  ADD CONSTRAINT campaigns_name_chk CHECK (char_length(name) BETWEEN 1 AND 200),
  ADD CONSTRAINT campaigns_description_chk CHECK (char_length(description) <= 1000),
  ADD CONSTRAINT campaigns_channel_chk CHECK (channel IN ('email', 'sms', 'whatsapp')),
  ADD CONSTRAINT campaigns_purpose_chk CHECK (purpose = 'marketing'),
  ADD CONSTRAINT campaigns_status_chk CHECK (status IN ('draft', 'scheduled', 'sending', 'paused', 'completed', 'cancelled', 'failed')),
  ADD CONSTRAINT campaigns_draft_shape_chk CHECK (jsonb_typeof(audience) = 'object' AND jsonb_typeof(sender) = 'object'
                                                  AND jsonb_typeof(messages) = 'array' AND jsonb_typeof(schedule) = 'object'),
  ADD CONSTRAINT campaigns_not_own_clone_chk CHECK (cloned_from_id IS DISTINCT FROM id),
  ADD CONSTRAINT campaigns_version_chk CHECK (version >= 1);

ALTER TABLE "campaign_versions"
  ADD CONSTRAINT campaign_versions_number_chk CHECK (number >= 1),
  ADD CONSTRAINT campaign_versions_schema_chk CHECK (schema IN ('campaign.version.v1')),
  ADD CONSTRAINT campaign_versions_snapshot_chk CHECK (jsonb_typeof(snapshot) = 'object' AND snapshot->>'schema' = schema),
  ADD CONSTRAINT campaign_versions_content_hash_chk CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT campaign_versions_reason_chk CHECK (reason IN ('scheduled', 'sent_now'));

ALTER TABLE "campaign_executions"
  ADD CONSTRAINT campaign_executions_run_number_chk CHECK (run_number >= 1),
  ADD CONSTRAINT campaign_executions_run_kind_chk CHECK (run_kind IN ('one_time')),
  ADD CONSTRAINT campaign_executions_status_chk CHECK (status IN ('pending', 'materializing', 'delivering', 'paused', 'completed', 'cancelled', 'failed')),
  ADD CONSTRAINT campaign_executions_paused_phase_chk CHECK ((status = 'paused') = (paused_phase IS NOT NULL)
                                                             AND (paused_phase IS NULL OR paused_phase IN ('materializing', 'delivering'))),
  ADD CONSTRAINT campaign_executions_counts_chk CHECK (planned >= 0 AND skipped >= 0 AND sent >= 0 AND failed >= 0 AND cancelled >= 0
                                                       AND unknown >= 0 AND (audience_size IS NULL OR audience_size >= 0)),
  ADD CONSTRAINT campaign_executions_skipped_by_reason_chk CHECK (jsonb_typeof(skipped_by_reason) = 'object'),
  ADD CONSTRAINT campaign_executions_failure_chk CHECK ((failure_class IS NULL) = (failure_code IS NULL)
                                                        AND (failure_class IS NULL OR failure_class = 'configuration')),
  ADD CONSTRAINT campaign_executions_health_chk CHECK (health IN ('ok', 'retrying', 'stalled')),
  ADD CONSTRAINT campaign_executions_lease_chk CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  ADD CONSTRAINT campaign_executions_version_chk CHECK (version >= 1);

ALTER TABLE "campaign_recipients"
  ADD CONSTRAINT campaign_recipients_status_chk CHECK (status IN ('pending', 'skipped', 'queued', 'sending', 'sent', 'failed',
                                                                   'skipped_at_send', 'unknown', 'cancelled')),
  ADD CONSTRAINT campaign_recipients_attempts_chk CHECK (attempts >= 0),
  ADD CONSTRAINT campaign_recipients_lease_chk CHECK ((lease_owner IS NULL) = (lease_until IS NULL));

-- ─── 2. Uniqueness that Prisma cannot express (contract §5.2, §10.2) ─────────────────────────────────────────────
-- A one-time version runs at most once; at most one active execution per campaign.
CREATE UNIQUE INDEX campaign_executions_one_time_version_key ON "campaign_executions" (version_id) WHERE run_kind = 'one_time';
CREATE UNIQUE INDEX campaign_executions_one_active_key ON "campaign_executions" (campaign_id)
  WHERE status IN ('pending', 'materializing', 'delivering', 'paused');
-- Due discovery for the Phase 8 scheduler (its definer function arrives with it).
CREATE INDEX campaign_executions_pending_send_at_idx ON "campaign_executions" (send_at) WHERE status = 'pending';

-- ─── 3. Immutability (defence in depth: also against the owner role) ─────────────────────────────────────────────
-- Versions are insert-only (contract §4.2).
CREATE TRIGGER campaign_versions_insert_only BEFORE UPDATE ON "campaign_versions" FOR EACH ROW EXECUTE FUNCTION app.reject_update();

-- Identity and provenance columns never change once written.
CREATE FUNCTION app.campaigns_freeze_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.org_id, NEW.workspace_id, NEW.channel, NEW.purpose, NEW.cloned_from_id, NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.org_id, OLD.workspace_id, OLD.channel, OLD.purpose, OLD.cloned_from_id, OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'campaign identity columns are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campaigns_freeze_identity BEFORE UPDATE ON "campaigns" FOR EACH ROW EXECUTE FUNCTION app.campaigns_freeze_identity();

-- An execution always runs the version it was created for.
CREATE FUNCTION app.campaign_executions_freeze_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.org_id, NEW.workspace_id, NEW.campaign_id, NEW.version_id, NEW.run_number, NEW.run_kind, NEW.initiated_by_user_id)
     IS DISTINCT FROM (OLD.id, OLD.org_id, OLD.workspace_id, OLD.campaign_id, OLD.version_id, OLD.run_number, OLD.run_kind, OLD.initiated_by_user_id) THEN
    RAISE EXCEPTION 'campaign execution identity columns are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campaign_executions_freeze_identity BEFORE UPDATE ON "campaign_executions" FOR EACH ROW EXECUTE FUNCTION app.campaign_executions_freeze_identity();

CREATE FUNCTION app.campaign_recipients_freeze_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.org_id, NEW.workspace_id, NEW.execution_id, NEW.contact_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.org_id, OLD.workspace_id, OLD.execution_id, OLD.contact_id, OLD.created_at) THEN
    RAISE EXCEPTION 'campaign recipient identity columns are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campaign_recipients_freeze_identity BEFORE UPDATE ON "campaign_recipients" FOR EACH ROW EXECUTE FUNCTION app.campaign_recipients_freeze_identity();
REVOKE ALL ON FUNCTION app.campaigns_freeze_identity(), app.campaign_executions_freeze_identity(),
  app.campaign_recipients_freeze_identity() FROM PUBLIC;

-- ─── 4. Privileges (least privilege; no DELETE on any campaign table — contract §14.4) ────────────────────────────
GRANT SELECT, INSERT ON "campaigns" TO workeasy_app;
GRANT UPDATE (name, description, topic_id, audience, sender, messages, schedule, status, current_version_id,
              current_execution_id, updated_at, deleted_at, version) ON "campaigns" TO workeasy_app;
GRANT SELECT, INSERT ON "campaign_versions" TO workeasy_app;                 -- insert-only
GRANT SELECT, INSERT ON "campaign_executions" TO workeasy_app;
GRANT UPDATE (status, paused_phase, send_at, started_at, audience_snapshot_id, captured_at, audience_size,
              materialization_cursor, snapshot_released_at, materialized_at, completed_at, cancelled_at, planned, skipped,
              sent, failed, cancelled, unknown, skipped_by_reason, failure_class, failure_code, health, last_progress_at,
              lease_owner, lease_until, paused_by_user_id, cancelled_by_user_id, version) ON "campaign_executions" TO workeasy_app;
GRANT SELECT, INSERT ON "campaign_recipients" TO workeasy_app;
GRANT UPDATE (address_identity_id, status, reason_codes, failure_code, attempts, lease_owner, lease_until, updated_at, final_at)
  ON "campaign_recipients" TO workeasy_app;
-- workeasy_reporting, workeasy_identity, workeasy_audience_count: nothing.

-- ─── 5. Row-level security: workspace-owned, forced, standard workspace policy (contract §12) ──────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['campaigns', 'campaign_versions', 'campaign_executions', 'campaign_recipients']
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

-- ─── 6. Campaign name search (trigram index under RLS; same pattern as app.search_contact_ids) ─────────────────────
-- ILIKE is not LEAKPROOF, so under RLS the trigram index is not used. This definer function performs the indexed match
-- bound to the CALLER'S current org + workspace, escapes LIKE wildcards, and returns ids only; callers load the rows
-- under normal RLS and apply every other filter there.
CREATE FUNCTION app.search_campaign_ids(p_query text, p_limit integer)
RETURNS TABLE (campaign_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.id FROM campaigns c
  WHERE c.org_id = app.current_org_id()
    AND c.workspace_id = app.current_workspace_id()
    AND length(p_query) >= 2
    AND c.name ILIKE '%' || replace(replace(replace(p_query, '!', '!!'), '%', '!%'), '_', '!_') || '%' ESCAPE '!'
  ORDER BY c.updated_at DESC, c.id DESC
  LIMIT least(greatest(p_limit, 1), 5000)
$$;
REVOKE ALL ON FUNCTION app.search_campaign_ids(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.search_campaign_ids(text, integer) TO workeasy_app;
