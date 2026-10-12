-- SMS inbound opt-out (messaging amendment §4, 2026-10-09). A recipient's STOP reply reaches Workeasy as a Twilio inbound
-- message: the sender's number and nothing else. The deployment's SMS number is shared by every workspace, and the
-- provider blocks it for that number from then on, so the opt-out is recorded in every workspace that TEXTED that
-- number through the provider (a provider_message_routes row for a recipient whose address was that phone identity).
-- Workspaces that never texted the number are untouched. Returns ids only; each consent change is then made inside its
-- tenant (RLS) through Audience's consent rules. Owner-owned (BYPASSRLS) because discovery crosses tenants, like
-- app.resolve_provider_message. Additive: indexes for the two lookups, no change to existing objects.

CREATE INDEX "contact_identities_phone_value_idx" ON "contact_identities"("value_normalized") WHERE kind = 'phone';
CREATE INDEX "provider_message_routes_delivery_id_idx" ON "provider_message_routes"("delivery_id");

CREATE FUNCTION app.sms_opt_out_targets(p_provider text, p_phone text)
RETURNS TABLE (org_id uuid, workspace_id uuid, contact_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT DISTINCT ci.org_id, ci.workspace_id, ci.contact_id
  FROM contact_identities ci
  WHERE ci.kind = 'phone' AND ci.value_normalized = p_phone
    AND EXISTS (
      SELECT 1 FROM campaign_recipients cr
      JOIN provider_message_routes r ON r.delivery_id = cr.id AND r.provider = p_provider
      WHERE cr.workspace_id = ci.workspace_id AND cr.contact_id = ci.contact_id AND cr.address_identity_id = ci.id)
  LIMIT 1000
$$;
REVOKE ALL ON FUNCTION app.sms_opt_out_targets(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.sms_opt_out_targets(text, text) TO workeasy_app;
