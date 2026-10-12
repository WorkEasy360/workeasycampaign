-- Sending domains and sender identities (Phase 7.8b; docs/contracts/phase-7-campaign-amendment.md §S).
-- A domain is "verified" only from real DNS checks (ownership TXT, SPF, DKIM, DMARC) recorded here; never claimed.
-- Workspace-owned: forced RLS on org AND workspace; soft delete only; live names unique case-insensitively.

CREATE TABLE "sending_domains" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    -- lower(domain) while live, NULL once deleted.
    "domain_key" TEXT,
    "verification_token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    -- Last DNS check, per record: { ownership, spf, dkim, dmarc: 'pass' | 'fail' | 'missing' | 'not_checked' }.
    "checks" JSONB NOT NULL DEFAULT '{}',
    "checked_at" TIMESTAMPTZ(3),
    "verified_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "sending_domains_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sending_domains_org_id_workspace_id_id_key" ON "sending_domains"("org_id", "workspace_id", "id");
CREATE UNIQUE INDEX "sending_domains_workspace_id_domain_key_key" ON "sending_domains"("workspace_id", "domain_key");
ALTER TABLE "sending_domains" ADD CONSTRAINT "sending_domains_org_id_workspace_id_fkey"
  FOREIGN KEY ("org_id", "workspace_id") REFERENCES "workspaces"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sending_domains"
  ADD CONSTRAINT sending_domains_domain_chk CHECK (domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' AND char_length(domain) <= 253),
  ADD CONSTRAINT sending_domains_key_chk CHECK ((deleted_at IS NULL) = (domain_key IS NOT NULL)),
  ADD CONSTRAINT sending_domains_status_chk CHECK (status IN ('pending', 'verified', 'failed')),
  ADD CONSTRAINT sending_domains_verified_chk CHECK ((status = 'verified') = (verified_at IS NOT NULL)),
  ADD CONSTRAINT sending_domains_token_chk CHECK (verification_token ~ '^[A-Za-z0-9_-]{20,64}$'),
  ADD CONSTRAINT sending_domains_checks_chk CHECK (jsonb_typeof(checks) = 'object');
GRANT SELECT, INSERT ON "sending_domains" TO workeasy_app;
GRANT UPDATE (domain_key, status, checks, checked_at, verified_at, updated_at, deleted_at, version) ON "sending_domains" TO workeasy_app;
ALTER TABLE "sending_domains" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sending_domains" FORCE ROW LEVEL SECURITY;
CREATE POLICY sending_domains_workspace ON "sending_domains" FOR ALL
  USING (org_id = app.current_org_id() AND workspace_id = app.current_workspace_id())
  WITH CHECK (org_id = app.current_org_id() AND workspace_id = app.current_workspace_id());

CREATE TABLE "sender_identities" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "domain_id" UUID NOT NULL,
    "local_part" TEXT NOT NULL,
    -- lower(local_part@domain) while live, NULL once deleted.
    "address_key" TEXT,
    "display_name" TEXT NOT NULL,
    "reply_to" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "sender_identities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sender_identities_org_id_workspace_id_id_key" ON "sender_identities"("org_id", "workspace_id", "id");
CREATE UNIQUE INDEX "sender_identities_workspace_id_address_key_key" ON "sender_identities"("workspace_id", "address_key");
CREATE INDEX "sender_identities_domain_idx" ON "sender_identities"("workspace_id", "domain_id");
ALTER TABLE "sender_identities" ADD CONSTRAINT "sender_identities_domain_fkey"
  FOREIGN KEY ("org_id", "workspace_id", "domain_id") REFERENCES "sending_domains"("org_id", "workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "sender_identities"
  ADD CONSTRAINT sender_identities_local_chk CHECK (local_part ~ '^[A-Za-z0-9!#$%&''*+/=?^_`{|}~.-]{1,64}$' AND local_part !~ '^\.|\.$|\.\.'),
  ADD CONSTRAINT sender_identities_key_chk CHECK ((deleted_at IS NULL) = (address_key IS NOT NULL)),
  ADD CONSTRAINT sender_identities_name_chk CHECK (char_length(display_name) BETWEEN 1 AND 100 AND display_name !~ '[\r\n\x00-\x1f\x7f"<>]'),
  ADD CONSTRAINT sender_identities_reply_chk CHECK (reply_to IS NULL OR (char_length(reply_to) BETWEEN 3 AND 320 AND reply_to !~ '[\s<>"\x00-\x1f\x7f]'));
GRANT SELECT, INSERT ON "sender_identities" TO workeasy_app;
GRANT UPDATE (address_key, display_name, reply_to, updated_at, deleted_at, version) ON "sender_identities" TO workeasy_app;
ALTER TABLE "sender_identities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sender_identities" FORCE ROW LEVEL SECURITY;
CREATE POLICY sender_identities_workspace ON "sender_identities" FOR ALL
  USING (org_id = app.current_org_id() AND workspace_id = app.current_workspace_id())
  WITH CHECK (org_id = app.current_org_id() AND workspace_id = app.current_workspace_id());
