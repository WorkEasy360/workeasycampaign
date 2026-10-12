-- Engagement rollups (Phase 7.9, additive to 20261026000000): the runtime role may update the facts only, never a
-- key (recipient, execution, tenant) — the security invariant "no runtime role can update an id or tenant-key column".
REVOKE UPDATE ON "recipient_engagement" FROM workeasy_app;
GRANT UPDATE ("delivered_at", "first_opened_at", "first_clicked_at", "bounced", "complained_at", "unsubscribed_at") ON "recipient_engagement" TO workeasy_app;
REVOKE UPDATE ON "execution_engagement" FROM workeasy_app;
GRANT UPDATE ("delivered", "bounced_hard", "bounced_soft", "complained", "unsubscribed", "opened_unique", "clicked_unique", "last_event_at") ON "execution_engagement" TO workeasy_app;
