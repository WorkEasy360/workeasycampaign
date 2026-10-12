-- Engagement events (Phase 7.9; docs/architecture/analytics-tracking.md, message.event.v1).
--  message_events        — append-only facts from verified provider webhooks; one row per provider event
--                          (UNIQUE (provider, provider_event_id): a replayed webhook changes nothing).
--  recipient_engagement  — per recipient: when it was first delivered/opened/clicked, bounce and complaint flags.
--  execution_engagement  — per execution: counters, incremented only when a recipient's FIRST occurrence is recorded
--                          (unique opens/clicks), in the same transaction as the event. Analytics read these rollups,
--                          never the raw events.
-- Ids only: no address, no content, no IP or user agent. Tenant comes from provider_message_routes, never a payload.

CREATE TABLE "message_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "provider" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    CONSTRAINT "message_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT message_events_type_chk CHECK (type IN ('delivered', 'deferred', 'bounced', 'complained', 'unsubscribed', 'opened', 'clicked')),
    CONSTRAINT message_events_provider_chk CHECK (provider ~ '^[a-z][a-z0-9_-]{0,39}$'),
    CONSTRAINT message_events_event_id_chk CHECK (char_length(provider_event_id) BETWEEN 1 AND 200),
    CONSTRAINT message_events_detail_chk CHECK (jsonb_typeof(detail) = 'object')
);
CREATE UNIQUE INDEX "message_events_provider_event_key" ON "message_events"("provider", "provider_event_id");
CREATE INDEX "message_events_execution_idx" ON "message_events"("workspace_id", "execution_id", "type");
CREATE INDEX "message_events_recipient_idx" ON "message_events"("recipient_id");
GRANT SELECT, INSERT ON "message_events" TO workeasy_app;
ALTER TABLE "message_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY message_events_workspace ON "message_events" FOR ALL
  USING (org_id = app.current_org_id() AND workspace_id = app.current_workspace_id())
  WITH CHECK (org_id = app.current_org_id() AND workspace_id = app.current_workspace_id());

CREATE TABLE "recipient_engagement" (
    "recipient_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "delivered_at" TIMESTAMPTZ(3),
    "first_opened_at" TIMESTAMPTZ(3),
    "first_clicked_at" TIMESTAMPTZ(3),
    "bounced" TEXT,
    "complained_at" TIMESTAMPTZ(3),
    "unsubscribed_at" TIMESTAMPTZ(3),
    CONSTRAINT "recipient_engagement_pkey" PRIMARY KEY ("recipient_id"),
    CONSTRAINT recipient_engagement_bounced_chk CHECK (bounced IS NULL OR bounced IN ('hard', 'soft'))
);
CREATE INDEX "recipient_engagement_execution_idx" ON "recipient_engagement"("workspace_id", "execution_id");
GRANT SELECT, INSERT, UPDATE ON "recipient_engagement" TO workeasy_app;
ALTER TABLE "recipient_engagement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recipient_engagement" FORCE ROW LEVEL SECURITY;
CREATE POLICY recipient_engagement_workspace ON "recipient_engagement" FOR ALL
  USING (org_id = app.current_org_id() AND workspace_id = app.current_workspace_id())
  WITH CHECK (org_id = app.current_org_id() AND workspace_id = app.current_workspace_id());

CREATE TABLE "execution_engagement" (
    "execution_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "delivered" INTEGER NOT NULL DEFAULT 0,
    "bounced_hard" INTEGER NOT NULL DEFAULT 0,
    "bounced_soft" INTEGER NOT NULL DEFAULT 0,
    "complained" INTEGER NOT NULL DEFAULT 0,
    "unsubscribed" INTEGER NOT NULL DEFAULT 0,
    "opened_unique" INTEGER NOT NULL DEFAULT 0,
    "clicked_unique" INTEGER NOT NULL DEFAULT 0,
    "last_event_at" TIMESTAMPTZ(3),
    CONSTRAINT "execution_engagement_pkey" PRIMARY KEY ("execution_id"),
    CONSTRAINT execution_engagement_nonneg_chk CHECK (delivered >= 0 AND bounced_hard >= 0 AND bounced_soft >= 0 AND complained >= 0 AND unsubscribed >= 0 AND opened_unique >= 0 AND clicked_unique >= 0)
);
GRANT SELECT, INSERT, UPDATE ON "execution_engagement" TO workeasy_app;
ALTER TABLE "execution_engagement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "execution_engagement" FORCE ROW LEVEL SECURITY;
CREATE POLICY execution_engagement_workspace ON "execution_engagement" FOR ALL
  USING (org_id = app.current_org_id() AND workspace_id = app.current_workspace_id())
  WITH CHECK (org_id = app.current_org_id() AND workspace_id = app.current_workspace_id());

-- Route resolution for webhooks needs the execution of a recipient too; resolve_provider_message (Phase 4) returns
-- the tenant and the delivery (recipient) id, and the recipient row is then read inside that tenant (RLS).
GRANT EXECUTE ON FUNCTION app.resolve_provider_message(text, text) TO workeasy_app;
