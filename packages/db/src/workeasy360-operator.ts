/**
 * Operator commands for WorkEasy360 Accounts sign-in (docs/workeasy360-sso.md §Operator commands). They run as the
 * schema owner (DATABASE_OWNER_URL), never as a runtime role, because each one deliberately crosses a boundary the
 * runtime is not allowed to cross: re-pointing an organization's link, vouching that two accounts are one person, or
 * moving identities to a new issuer. Every change is recorded (audit log or security log).
 *
 * The CLI is workeasy360-cli.ts; these functions take a connected client so tests can drive them directly.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class OperatorError extends Error {
  override name = 'OperatorError';
}

function uuid(value: string, what: string): string {
  if (!UUID_RE.test(value)) throw new OperatorError(`${what} must be a UUID`);
  return value.toLowerCase();
}

function issuerOf(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OperatorError(`not an issuer URL: ${value}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new OperatorError(`not an issuer URL: ${value}`);
  if (value.endsWith('/')) throw new OperatorError('an issuer has no trailing slash');
  return value;
}

async function inTransaction<T>(client: pg.Client, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

async function audit(client: pg.Client, orgId: string, action: string, metadata: Record<string, unknown>): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (id, org_id, actor_type, action, target_type, target_id, correlation_id, metadata)
     VALUES ($1, $2, 'system', $3, 'organization', $4, $5, $6::jsonb)`,
    [randomUUID(), orgId, action, orgId, randomUUID(), JSON.stringify({ ...metadata, via: 'operator' })],
  );
}

/**
 * Sign-ins from `workeasy360OrganizationId` land in the existing organization `orgId` from now on. Refused when the
 * organization is linked to another WorkEasy360 organization (never re-pointed silently), or when the WorkEasy360
 * organization already has an organization here (unlink that one first).
 */
export async function linkOrganization(client: pg.Client, orgIdRaw: string, workeasy360OrganizationIdRaw: string): Promise<{ changed: boolean }> {
  const orgId = uuid(orgIdRaw, 'organization id');
  const w360 = uuid(workeasy360OrganizationIdRaw, 'WorkEasy360 organization id');
  return inTransaction(client, async () => {
    const org = (await client.query<{ status: string; link: string | null }>(
      'SELECT status, workeasy360_organization_id AS link FROM organizations WHERE id = $1 FOR UPDATE', [orgId])).rows[0];
    if (!org) throw new OperatorError(`no organization ${orgId}`);
    if (org.status === 'deleted') throw new OperatorError(`organization ${orgId} is deleted`);
    if (org.link === w360) return { changed: false };
    if (org.link) throw new OperatorError(`organization ${orgId} is already linked to WorkEasy360 organization ${org.link}; unlink it first`);
    const other = (await client.query<{ id: string }>('SELECT id FROM organizations WHERE workeasy360_organization_id = $1', [w360])).rows[0];
    if (other) throw new OperatorError(`WorkEasy360 organization ${w360} is already linked to organization ${other.id}; unlink that one first`);
    await client.query('UPDATE organizations SET workeasy360_organization_id = $2, updated_at = now(), version = version + 1 WHERE id = $1', [orgId, w360]);
    await audit(client, orgId, 'organization.linked_to_workeasy360', { workeasy360OrganizationId: w360 });
    return { changed: true };
  });
}

/** Removes an organization's link. Its WorkEasy360 sessions end at once; WorkEasy360 sign-ins no longer land in it. */
export async function unlinkOrganization(client: pg.Client, orgIdRaw: string): Promise<{ changed: boolean; sessionsEnded: number }> {
  const orgId = uuid(orgIdRaw, 'organization id');
  return inTransaction(client, async () => {
    const org = (await client.query<{ link: string | null }>(
      'SELECT workeasy360_organization_id AS link FROM organizations WHERE id = $1 FOR UPDATE', [orgId])).rows[0];
    if (!org) throw new OperatorError(`no organization ${orgId}`);
    if (!org.link) return { changed: false, sessionsEnded: 0 };
    await client.query('UPDATE organizations SET workeasy360_organization_id = NULL, updated_at = now(), version = version + 1 WHERE id = $1', [orgId]);
    const ended = await client.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'workeasy360_unlinked'
        WHERE provider = 'workeasy360' AND bound_org_id = $1 AND revoked_at IS NULL`, [orgId]);
    await audit(client, orgId, 'organization.unlinked_from_workeasy360', { workeasy360OrganizationId: org.link, sessionsEnded: ended.rowCount ?? 0 });
    return { changed: true, sessionsEnded: ended.rowCount ?? 0 };
  });
}

/**
 * The operator vouches that an existing account (a password account) is the WorkEasy360 person `subject` under
 * `issuer`: that person's WorkEasy360 sign-ins then reach this account, with its memberships and roles. Refused when
 * that WorkEasy360 person already has an account here, or this account already has another WorkEasy360 identity.
 * Nothing is ever linked by email automatically: this command is the only way two accounts become one.
 */
export async function linkUser(client: pg.Client, userRef: string, subject: string, issuerRaw: string): Promise<{ userId: string }> {
  const issuer = issuerOf(issuerRaw);
  if (!subject || subject.length > 255) throw new OperatorError('subject must be 1-255 characters');
  return inTransaction(client, async () => {
    const user = (await client.query<{ id: string; status: string }>(
      UUID_RE.test(userRef) ? 'SELECT id, status FROM users WHERE id = $1 FOR UPDATE' : 'SELECT id, status FROM users WHERE email_normalized = lower($1) FOR UPDATE',
      [userRef],
    )).rows[0];
    if (!user) throw new OperatorError(`no user ${userRef}`);
    if (user.status !== 'active') throw new OperatorError(`user ${user.id} is ${user.status}`);
    const taken = (await client.query<{ user_id: string; issuer: string }>(
      `SELECT user_id, issuer FROM user_identities WHERE provider = 'workeasy360' AND subject = $1`, [subject])).rows[0];
    if (taken) throw new OperatorError(`WorkEasy360 subject ${subject} already belongs to user ${taken.user_id} (issuer ${taken.issuer})`);
    const own = (await client.query<{ subject: string }>(
      `SELECT subject FROM user_identities WHERE provider = 'workeasy360' AND user_id = $1`, [user.id])).rows[0];
    if (own) throw new OperatorError(`user ${user.id} already has WorkEasy360 identity ${own.subject}`);
    await client.query(
      `INSERT INTO user_identities (id, user_id, provider, subject, issuer) VALUES ($1, $2, 'workeasy360', $3, $4)`,
      [randomUUID(), user.id, subject, issuer]);
    await client.query(
      `INSERT INTO security_events (id, user_id, type, correlation_id, metadata) VALUES ($1, $2, 'workeasy360.identity_linked', $3, $4::jsonb)`,
      [randomUUID(), user.id, randomUUID(), JSON.stringify({ issuer, via: 'operator' })]);
    return { userId: user.id };
  });
}

/**
 * The identity move of an issuer change (WorkEasy360's staged issuer move): every WorkEasy360 identity and live
 * session under `from` moves to `to`, in the same release that changes WORKEASY360_ISSUER. Without `apply` it only
 * reports. Subjects are unique across issuers, so two accounts are never merged by a move.
 */
export async function moveIssuer(client: pg.Client, fromRaw: string, toRaw: string, apply: boolean): Promise<{ identities: number; sessions: number; applied: boolean }> {
  const from = issuerOf(fromRaw);
  const to = issuerOf(toRaw);
  if (from === to) throw new OperatorError('--from and --to are the same issuer');
  return inTransaction(client, async () => {
    const counts = (await client.query<{ identities: number; sessions: number }>(
      `SELECT (SELECT count(*)::int FROM user_identities WHERE provider = 'workeasy360' AND issuer = $1) AS identities,
              (SELECT count(*)::int FROM sessions WHERE provider = 'workeasy360' AND workeasy360_issuer = $1 AND revoked_at IS NULL) AS sessions`,
      [from])).rows[0]!;
    if (!apply) return { ...counts, applied: false };
    await client.query(`UPDATE user_identities SET issuer = $2 WHERE provider = 'workeasy360' AND issuer = $1`, [from, to]);
    await client.query(
      `UPDATE sessions SET workeasy360_issuer = $2 WHERE provider = 'workeasy360' AND workeasy360_issuer = $1 AND revoked_at IS NULL`, [from, to]);
    return { ...counts, applied: true };
  });
}

/** WorkEasy360 identities and live WorkEasy360 sessions per issuer, and linked organizations. */
export async function identitiesReport(client: pg.Client): Promise<{ issuers: { issuer: string; identities: number; liveSessions: number }[]; linkedOrganizations: number }> {
  const issuers = (await client.query<{ issuer: string; identities: number; live_sessions: number }>(
    `SELECT issuer, sum(identities)::int AS identities, sum(live_sessions)::int AS live_sessions FROM (
       SELECT issuer, count(*) AS identities, 0 AS live_sessions FROM user_identities WHERE provider = 'workeasy360' GROUP BY issuer
       UNION ALL
       SELECT workeasy360_issuer, 0, count(*) FROM sessions
        WHERE provider = 'workeasy360' AND revoked_at IS NULL AND absolute_expires_at > now() GROUP BY workeasy360_issuer
     ) t GROUP BY issuer ORDER BY issuer`)).rows;
  const linked = (await client.query<{ n: number }>('SELECT count(*)::int AS n FROM organizations WHERE workeasy360_organization_id IS NOT NULL')).rows[0]!.n;
  return { issuers: issuers.map((r) => ({ issuer: r.issuer, identities: r.identities, liveSessions: r.live_sessions })), linkedOrganizations: linked };
}
