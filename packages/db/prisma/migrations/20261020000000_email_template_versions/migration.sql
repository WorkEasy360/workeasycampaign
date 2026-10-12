-- Template version history and categories (Phase 7.1, docs/contracts/phase-7-content-amendment.md §T).
-- Every template change (create, update, restore) records the template's state AFTER the change as an immutable row,
-- keyed by the template's optimistic-lock version. Restore never rewrites history: it records a NEW version whose
-- content is copied from an older one. Same tenancy model as email_templates (forced RLS on org AND workspace).

ALTER TABLE "email_templates" ADD COLUMN "category" TEXT;
ALTER TABLE "email_templates"
  ADD CONSTRAINT email_templates_category_chk CHECK (category IS NULL OR char_length(category) BETWEEN 1 AND 60);
GRANT UPDATE (category) ON "email_templates" TO workeasy_app;
CREATE INDEX "email_templates_workspace_category_idx" ON "email_templates"("workspace_id", lower("category"))
  WHERE "deleted_at" IS NULL AND "category" IS NOT NULL;

CREATE TABLE "email_template_versions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    -- created | updated | restored | imported (state that existed before history was recorded)
    "change" TEXT NOT NULL,
    "restored_from_version" INTEGER,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT,
    "content" JSONB NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_template_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_template_versions_template_id_version_key" ON "email_template_versions"("template_id", "version");
CREATE INDEX "email_template_versions_workspace_template_idx" ON "email_template_versions"("workspace_id", "template_id", "version" DESC);

ALTER TABLE "email_template_versions" ADD CONSTRAINT "email_template_versions_template_fkey"
  FOREIGN KEY ("org_id", "workspace_id", "template_id") REFERENCES "email_templates"("org_id", "workspace_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "email_template_versions"
  ADD CONSTRAINT email_template_versions_version_chk CHECK (version >= 1),
  ADD CONSTRAINT email_template_versions_change_chk CHECK (change IN ('created', 'updated', 'restored', 'imported')),
  ADD CONSTRAINT email_template_versions_restored_chk CHECK ((change = 'restored') = (restored_from_version IS NOT NULL)),
  ADD CONSTRAINT email_template_versions_name_chk CHECK (char_length(name) BETWEEN 1 AND 120),
  ADD CONSTRAINT email_template_versions_description_chk CHECK (char_length(description) <= 500),
  ADD CONSTRAINT email_template_versions_category_chk CHECK (category IS NULL OR char_length(category) BETWEEN 1 AND 60),
  ADD CONSTRAINT email_template_versions_content_chk CHECK (jsonb_typeof(content) = 'object' AND content->>'schema' = 'email.content.v2');

-- Insert-only: the runtime role may not UPDATE or DELETE, and an UPDATE by anyone is rejected.
GRANT SELECT, INSERT ON "email_template_versions" TO workeasy_app;
CREATE TRIGGER email_template_versions_insert_only BEFORE UPDATE ON "email_template_versions" FOR EACH ROW EXECUTE FUNCTION app.reject_update();

ALTER TABLE "email_template_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_template_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY email_template_versions_workspace ON "email_template_versions" FOR ALL
  USING (org_id = app.current_org_id() AND workspace_id = app.current_workspace_id())
  WITH CHECK (org_id = app.current_org_id() AND workspace_id = app.current_workspace_id());

-- Backfill: the current state of every template (live or deleted) becomes its first recorded version.
INSERT INTO "email_template_versions" (id, org_id, workspace_id, template_id, version, change, name, description, category, content, created_by_user_id, created_at)
SELECT gen_random_uuid(), org_id, workspace_id, id, version, 'imported', name, description, category, content, created_by_user_id, updated_at
  FROM "email_templates";
