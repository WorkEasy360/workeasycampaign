-- email.content.v3 and campaign.version.v3 (docs/contracts/phase-7-content-amendment.md §C, decision C17).
-- Only widens the allowed schema ids; nothing stored changes. The full shapes are validated by the application on
-- write AND read (strict Zod schemas; v3 HTML additionally by the @workeasy/content sanitizer).

ALTER TABLE "campaign_versions" DROP CONSTRAINT campaign_versions_schema_chk,
  ADD CONSTRAINT campaign_versions_schema_chk CHECK (schema IN ('campaign.version.v1', 'campaign.version.v2', 'campaign.version.v3'));

ALTER TABLE "email_templates" DROP CONSTRAINT email_templates_content_chk,
  ADD CONSTRAINT email_templates_content_chk CHECK (jsonb_typeof(content) = 'object' AND content->>'schema' IN ('email.content.v2', 'email.content.v3'));

ALTER TABLE "email_template_versions" DROP CONSTRAINT email_template_versions_content_chk,
  ADD CONSTRAINT email_template_versions_content_chk CHECK (jsonb_typeof(content) = 'object' AND content->>'schema' IN ('email.content.v2', 'email.content.v3'));
