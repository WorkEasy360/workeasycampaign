-- Content amendment (docs/contracts/phase-6-content-amendment.md, decisions C3/C4): new campaign versions are
-- written as campaign.version.v2. Stored v1 versions are never rewritten; this only widens the allowed schema ids.
-- The constraint is re-created in one statement under the table's ACCESS EXCLUSIVE lock (append-only, small table).
ALTER TABLE "campaign_versions"
  DROP CONSTRAINT campaign_versions_schema_chk,
  ADD CONSTRAINT campaign_versions_schema_chk CHECK (schema IN ('campaign.version.v1', 'campaign.version.v2'));
