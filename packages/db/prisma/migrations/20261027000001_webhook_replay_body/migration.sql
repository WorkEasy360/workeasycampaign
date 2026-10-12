-- Bind each webhook signature token to the body it arrived with (Phase 7.9, additive to 20261027000000).
-- A provider RETRY of the same delivery reuses the token with the same body and must be accepted (the events are
-- deduplicated by provider event id, so it changes nothing twice — and a retry after a failed first attempt is how the
-- feedback is not lost). The same token with a DIFFERENT body is a forged replay and is refused.
-- Rows written before this migration (none outside development) keep a NULL body hash and accept no reuse.

ALTER TABLE "webhook_replay_tokens" ADD COLUMN "body_hash" BYTEA;
ALTER TABLE "webhook_replay_tokens" ADD CONSTRAINT webhook_replay_tokens_body_hash_chk CHECK (body_hash IS NULL OR octet_length(body_hash) = 32);

-- 'new' = first use; 'retry' = same token, same body; 'forged' = same token, different body.
CREATE FUNCTION app.claim_webhook_token(p_provider text, p_token_hash bytea, p_body_hash bytea)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE prior bytea; found_row boolean;
BEGIN
  IF octet_length(p_body_hash) IS DISTINCT FROM 32 THEN RAISE EXCEPTION 'body hash must be 32 bytes'; END IF;
  DELETE FROM webhook_replay_tokens WHERE ctid = ANY (ARRAY(
    SELECT ctid FROM webhook_replay_tokens WHERE received_at < now() - interval '2 days' ORDER BY received_at LIMIT 100));
  INSERT INTO webhook_replay_tokens (provider, token_hash, body_hash) VALUES (p_provider, p_token_hash, p_body_hash)
    ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN 'new'; END IF;
  SELECT body_hash, true INTO prior, found_row FROM webhook_replay_tokens WHERE provider = p_provider AND token_hash = p_token_hash;
  IF found_row AND prior = p_body_hash THEN RETURN 'retry'; END IF;
  RETURN 'forged';
END
$$;
REVOKE ALL ON FUNCTION app.claim_webhook_token(text, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_webhook_token(text, bytea, bytea) TO workeasy_app;
-- The two-argument form is superseded; nothing may call it.
REVOKE EXECUTE ON FUNCTION app.claim_webhook_token(text, bytea) FROM workeasy_app;
