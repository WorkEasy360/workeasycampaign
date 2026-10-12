-- Least privilege (Gate D; audit 6.13 known item "snapshot-guard grant"): app.audience_snapshot_guard() is a trigger
-- function created without the REVOKE every other app function has, so PUBLIC kept the default EXECUTE privilege.
-- A trigger function's EXECUTE privilege is checked only when a trigger is CREATED, not when it fires, so revoking it
-- changes no behaviour; it removes a callable surface that has no business being reachable. Additive: the original
-- migration is applied and immutable.
REVOKE ALL ON FUNCTION app.audience_snapshot_guard() FROM PUBLIC;
