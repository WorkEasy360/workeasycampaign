-- Reusable saved blocks ("snippets", Phase 7.2, docs/contracts/phase-7-content-amendment.md §S). Workspace-owned
-- email.content.v3 blocks a user can insert into any designed email. Inserting COPIES the blocks (fresh ids); emails
-- keep no link. Same tenancy model as email_templates: forced RLS on org AND workspace, soft delete only.

CREATE TABLE "email_snippets" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT,
    -- { "schema": "email.snippet.v1", "blocks": [ email.content.v3 blocks ] } — validated by the application on write and read.
    "content" JSONB NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "email_snippets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_snippets_org_id_workspace_id_id_key" ON "email_snippets"("org_id", "workspace_id", "id");
CREATE UNIQUE INDEX "email_snippets_workspace_id_name_key_key" ON "email_snippets"("workspace_id", "name_key");
CREATE INDEX "email_snippets_workspace_id_updated_at_id_idx" ON "email_snippets"("workspace_id", "updated_at" DESC, "id" DESC);

ALTER TABLE "email_snippets" ADD CONSTRAINT "email_snippets_org_id_workspace_id_fkey"
  FOREIGN KEY ("org_id", "workspace_id") REFERENCES "workspaces"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "email_snippets"
  ADD CONSTRAINT email_snippets_name_chk CHECK (char_length(name) BETWEEN 1 AND 120),
  ADD CONSTRAINT email_snippets_name_key_chk CHECK ((deleted_at IS NULL) = (name_key IS NOT NULL)),
  ADD CONSTRAINT email_snippets_content_chk CHECK (jsonb_typeof(content) = 'object' AND content->>'schema' = 'email.snippet.v1' AND jsonb_typeof(content->'blocks') = 'array'),
  ADD CONSTRAINT email_snippets_version_chk CHECK (version >= 1);

GRANT SELECT, INSERT ON "email_snippets" TO workeasy_app;
GRANT UPDATE (name, name_key, content, updated_at, deleted_at, version) ON "email_snippets" TO workeasy_app;

ALTER TABLE "email_snippets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_snippets" FORCE ROW LEVEL SECURITY;
CREATE POLICY email_snippets_workspace ON "email_snippets" FOR ALL
  USING (org_id = app.current_org_id() AND workspace_id = app.current_workspace_id())
  WITH CHECK (org_id = app.current_org_id() AND workspace_id = app.current_workspace_id());
