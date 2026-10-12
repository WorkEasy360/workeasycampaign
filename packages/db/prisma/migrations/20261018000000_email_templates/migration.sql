-- Email templates (docs/contracts/phase-6-content-amendment.md §6, decision C8): workspace-owned reusable
-- email.content.v2 content. Applying a template COPIES its content into a campaign draft; campaigns keep no link.
-- Same tenancy model as lists: forced RLS on org AND workspace, the runtime role may not DELETE (soft delete only).

CREATE TABLE "email_templates" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    -- lower(name) while live; NULL once deleted, so a deleted template's name can be reused.
    "name_key" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "content" JSONB NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_templates_org_id_workspace_id_id_key" ON "email_templates"("org_id", "workspace_id", "id");
CREATE UNIQUE INDEX "email_templates_workspace_id_name_key_key" ON "email_templates"("workspace_id", "name_key");
-- List order (most recently updated first) as a keyset.
CREATE INDEX "email_templates_workspace_id_updated_at_id_idx" ON "email_templates"("workspace_id", "updated_at" DESC, "id" DESC);

ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_org_id_workspace_id_fkey"
  FOREIGN KEY ("org_id", "workspace_id") REFERENCES "workspaces"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "email_templates"
  ADD CONSTRAINT email_templates_name_chk CHECK (char_length(name) BETWEEN 1 AND 120),
  ADD CONSTRAINT email_templates_name_key_chk CHECK ((deleted_at IS NULL) = (name_key IS NOT NULL)),
  ADD CONSTRAINT email_templates_description_chk CHECK (char_length(description) <= 500),
  -- The full shape is validated by the application on write AND read (strict Zod schema); the database guards the id.
  ADD CONSTRAINT email_templates_content_chk CHECK (jsonb_typeof(content) = 'object' AND content->>'schema' = 'email.content.v2'),
  ADD CONSTRAINT email_templates_version_chk CHECK (version >= 1);

GRANT SELECT, INSERT ON "email_templates" TO workeasy_app;
GRANT UPDATE (name, name_key, description, content, updated_at, deleted_at, version) ON "email_templates" TO workeasy_app;

ALTER TABLE "email_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY email_templates_workspace ON "email_templates" FOR ALL
  USING (org_id = app.current_org_id() AND workspace_id = app.current_workspace_id())
  WITH CHECK (org_id = app.current_org_id() AND workspace_id = app.current_workspace_id());
