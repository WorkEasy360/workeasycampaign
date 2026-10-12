-- SMS and WhatsApp campaigns (messaging amendment, 2026-10-09): campaign.version.v4 snapshots (SMS / WhatsApp only;
-- email keeps v1–v3). Stored versions are never rewritten; this only widens the allowed schema ids. Additive.
ALTER TABLE "campaign_versions" DROP CONSTRAINT campaign_versions_schema_chk,
  ADD CONSTRAINT campaign_versions_schema_chk CHECK (schema IN ('campaign.version.v1', 'campaign.version.v2', 'campaign.version.v3', 'campaign.version.v4'));
