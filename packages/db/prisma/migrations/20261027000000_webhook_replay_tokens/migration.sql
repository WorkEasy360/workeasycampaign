-- Single-use webhook signature tokens (Phase 7.9; docs/architecture/delivery-providers.md §6).
-- Mailgun signs `timestamp + token`, NOT the event body, so a captured signature could be replayed with a different
-- body inside the 15-minute window. Each token is therefore accepted once: the ingestion claims a hash of it here before
-- anything else. Not tenant data (the tenant is unknown at that point): like job_queue, the table has RLS forced, no
-- policy and no grants, and is reachable only through the definer function below. Tokens older than two days are
-- purged as new ones arrive (the window is 15 minutes, so nothing that could still verify is ever purged).

CREATE TABLE "webhook_replay_tokens" (
    "provider" TEXT NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    CONSTRAINT "webhook_replay_tokens_pkey" PRIMARY KEY ("provider", "token_hash"),
    CONSTRAINT webhook_replay_tokens_hash_chk CHECK (octet_length(token_hash) = 32)
);
CREATE INDEX "webhook_replay_tokens_received_idx" ON "webhook_replay_tokens"("received_at");
REVOKE ALL ON "webhook_replay_tokens" FROM PUBLIC;
ALTER TABLE "webhook_replay_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_replay_tokens" FORCE ROW LEVEL SECURITY;

-- true = first use (proceed); false = seen before (replay: drop).
CREATE FUNCTION app.claim_webhook_token(p_provider text, p_token_hash bytea)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE inserted int;
BEGIN
  DELETE FROM webhook_replay_tokens WHERE ctid = ANY (ARRAY(
    SELECT ctid FROM webhook_replay_tokens WHERE received_at < now() - interval '2 days' ORDER BY received_at LIMIT 100));
  INSERT INTO webhook_replay_tokens (provider, token_hash) VALUES (p_provider, p_token_hash) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted = 1;
END
$$;
REVOKE ALL ON FUNCTION app.claim_webhook_token(text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_webhook_token(text, bytea) TO workeasy_app;
