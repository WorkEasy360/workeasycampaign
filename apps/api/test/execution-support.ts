import { consentFingerprint } from '@workeasy/audience-core';
import { randomUUID } from 'node:crypto';
import { withOwnerConnection } from './support.js';

/**
 * Seeds an audience directly (owner connection), for execution tests and benchmarks: `n` contacts with a primary email
 * identity, `eligible` of them with GRANTED email consent bound to that address by the real fingerprint (so Eligibility
 * treats them exactly like consent recorded through the API), all members of `listId`. Ids ascend with insertion.
 */
export async function seedAudience(opts: { orgId: string; workspaceId: string; listId: string; n: number; eligible: number; secret: string; tag?: string }) {
  const { orgId, workspaceId, listId, n, eligible, secret } = opts;
  const tag = opts.tag ?? randomUUID().slice(0, 8);
  const ids: string[] = [];
  const emails: string[] = [];
  const fps: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(randomUUID());
    const email = `x${i}-${tag}@seed.test`;
    emails.push(email);
    fps.push(consentFingerprint(secret, 'email', email));
  }
  await withOwnerConnection(async (c) => {
    await c.query('SET statement_timeout = 0');
    await c.query('BEGIN');
    await c.query(`CREATE TEMP TABLE s_a ON COMMIT DROP AS SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[]) WITH ORDINALITY AS t(id, email, fp, g)`, [ids, emails, fps]);
    await c.query(`INSERT INTO contacts (id, org_id, workspace_id) SELECT id, $1, $2 FROM s_a`, [orgId, workspaceId]);
    await c.query('ANALYZE contacts');
    await c.query(
      `INSERT INTO contact_identities (id, org_id, workspace_id, contact_id, kind, value, value_normalized, is_primary)
       SELECT gen_random_uuid(), $1, $2, id, 'email', email, email, true FROM s_a`,
      [orgId, workspaceId],
    );
    await c.query(`CREATE TEMP TABLE s_e ON COMMIT DROP AS SELECT id, fp, gen_random_uuid() AS ev FROM s_a WHERE g <= $1`, [eligible]);
    await c.query(
      `INSERT INTO consent_events (id, org_id, workspace_id, contact_id, channel, action, previous_state, new_state, source, actor_type, correlation_id, occurred_at, subject_fingerprint)
       SELECT ev, $1, $2, id, 'email', 'subscribed', 'none', 'granted', 'admin', 'user', gen_random_uuid(), now(), fp FROM s_e`,
      [orgId, workspaceId],
    );
    await c.query(
      `INSERT INTO consent_states (org_id, workspace_id, contact_id, channel, state, changed_by, last_event_id, changed_at, subject_fingerprint, lawful_basis)
       SELECT $1, $2, id, 'email', 'granted', 'user', ev, now(), fp, 'consent' FROM s_e`,
      [orgId, workspaceId],
    );
    await c.query(`INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id) SELECT $1, $2, $3, id FROM s_a`, [orgId, workspaceId, listId]);
    await c.query('COMMIT');
    await c.query('ANALYZE contacts, contact_identities, consent_states, list_memberships');
  });
  return { ids, emails, eligibleIds: ids.slice(0, eligible) };
}
