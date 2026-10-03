/**
 * Query-plan checks for the audience hot paths (docs/audience.md §8). Seeds 20 000 contacts in one workspace and
 * 5 000 in another, then asserts — as the runtime role, with RLS active — that the planner uses the intended indexes.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetTestDatabase, testDatabaseUrls, withOwnerConnection } from '../src/testing.js';

const org = randomUUID();
const ws = randomUUID();
const other = randomUUID();
const list = randomUUID();
let client: pg.Client;

beforeAll(async () => {
  await resetTestDatabase();
  await withOwnerConnection(async (c) => {
    const user = randomUUID();
    await c.query(`INSERT INTO users (id, email, email_normalized, display_name) VALUES ($1, 'q@x.test', 'q@x.test', 'Q')`, [user]);
    await c.query(`INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES ($1, 'q', 'q', $2)`, [org, user]);
    for (const w of [ws, other]) await c.query(`INSERT INTO workspaces (id, org_id, name, slug) VALUES ($1::uuid, $2, $1::text, $1::text)`, [w, org]);
    for (const [w, n] of [[ws, 20000], [other, 5000]] as const) {
      await c.query(
        `INSERT INTO contacts (id, org_id, workspace_id, first_name, last_name, search_text, created_at, updated_at)
         SELECT gen_random_uuid(), $1, $2, 'First' || g, 'Last' || g, lower('first' || g || ' last' || g || ' user' || g || '@example.test'),
                now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval
         FROM generate_series(1, $3) g`,
        [org, w, n],
      );
      await c.query(
        `INSERT INTO contact_identities (id, org_id, workspace_id, contact_id, kind, value, value_normalized, is_primary)
         SELECT gen_random_uuid(), org_id, workspace_id, id, 'email', split_part(search_text, ' ', 3), split_part(search_text, ' ', 3), true
         FROM contacts WHERE workspace_id = $1`,
        [w],
      );
    }
    const big = randomUUID();
    await c.query(`INSERT INTO lists (id, org_id, workspace_id, name, name_key) VALUES ($1, $2, $3, 'L', 'l'), ($4, $2, $3, 'Big', 'big')`, [list, org, ws, big]);
    await c.query(
      `INSERT INTO list_memberships (org_id, workspace_id, list_id, contact_id)
       SELECT org_id, workspace_id, CASE WHEN rn <= 200 THEN $1::uuid ELSE $3::uuid END, id
       FROM (SELECT *, row_number() OVER (ORDER BY created_at) rn FROM contacts WHERE workspace_id = $2) x`,
      [list, ws, big],
    );
    await c.query('ANALYZE contacts, contact_identities, list_memberships');
  });
  client = new pg.Client({ connectionString: testDatabaseUrls().app });
  await client.connect();
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.org_id', $1, true), set_config('app.workspace_id', $2, true)`, [org, ws]);
}, 120_000);

afterAll(async () => {
  await client?.query('ROLLBACK');
  await client?.end();
});

async function plan(sql: string, params: unknown[] = []): Promise<string> {
  const r = await client.query(`EXPLAIN ${sql}`, params);
  return r.rows.map((x: Record<string, string>) => x['QUERY PLAN']).join('\n');
}

describe('audience query plans (RLS active, 25 000 contacts)', () => {
  it('first page of contacts uses the (workspace, created_at, id) index — no full scan', async () => {
    const p = await plan(`SELECT id FROM contacts WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 51`, [ws]);
    expect(p).toMatch(/contacts_workspace_id_created_at_id_idx/);
    expect(p).not.toMatch(/Seq Scan on contacts/);
  });

  it('keyset page 2 seeks with the same index', async () => {
    const p = await plan(
      `SELECT id FROM contacts WHERE workspace_id = $1 AND (created_at, id) < (now() - interval '100 minutes', '00000000-0000-0000-0000-000000000000'::uuid)
       ORDER BY created_at DESC, id DESC LIMIT 51`,
      [ws],
    );
    expect(p).toMatch(/contacts_workspace_id_created_at_id_idx/);
  });

  it('a plain ILIKE under RLS cannot use the trigram index (why app.search_contact_ids exists)', async () => {
    const p = await plan(`SELECT id FROM contacts WHERE workspace_id = $1 AND search_text ILIKE $2 LIMIT 51`, [ws, '%user1234@%']);
    expect(p).toMatch(/Seq Scan on contacts/);
  });

  it('app.search_contact_ids uses the trigram index and stays inside the current workspace', async () => {
    const owner = await withOwnerConnection(async (c) => {
      // Plan of the function body as executed by its owner (definer), parameters inlined.
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.org_id', $1, true), set_config('app.workspace_id', $2, true)`, [org, ws]);
      const r = await c.query(`EXPLAIN SELECT c.id FROM contacts c WHERE c.org_id = app.current_org_id() AND c.workspace_id = app.current_workspace_id()
        AND c.search_text ILIKE '%user1234@%' ORDER BY c.created_at DESC LIMIT 200`);
      await c.query('ROLLBACK');
      return r.rows.map((x: Record<string, string>) => x['QUERY PLAN']).join('\n');
    });
    expect(owner).toMatch(/contacts_search_text_idx/);
    const hits = await client.query('SELECT contact_id FROM app.search_contact_ids($1, 50)', ['user1234@']);
    expect(hits.rowCount).toBe(1);
    // Wildcards in user input are literal, not patterns.
    expect((await client.query('SELECT contact_id FROM app.search_contact_ids($1, 50)', ['%'])).rowCount).toBe(0);
    expect((await client.query('SELECT contact_id FROM app.search_contact_ids($1, 50)', ['u_er1'])).rowCount).toBe(0);
  });

  it('lookup by normalized address uses the identity unique index', async () => {
    const p = await plan(
      `SELECT contact_id FROM contact_identities WHERE workspace_id = $1 AND kind = 'email' AND provider = '' AND value_normalized = $2`,
      [ws, 'user42@example.test'],
    );
    expect(p).toMatch(/Index Scan using contact_identities_workspace_id_kind_provider_value_normali/); // name truncated to 63 chars by PostgreSQL
  });

  it('list members are read through the membership primary key', async () => {
    const p = await plan(`SELECT contact_id FROM list_memberships WHERE list_id = $1 LIMIT 51`, [list]);
    expect(p).toMatch(/list_memberships_pkey/);
  });
});
