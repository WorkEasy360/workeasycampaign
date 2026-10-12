/**
 * One-time cluster bootstrap, run with a superuser/admin connection (DATABASE_ADMIN_URL).
 * Creates the four roles and the dev + test databases. Table-level privileges are NOT granted here — they are
 * part of the migrations, so hosted databases get exactly the same grants.
 *
 * Roles (docs/security.md §Database roles):
 *   workeasy_owner      schema owner; runs migrations; owns SECURITY DEFINER functions. BYPASSRLS. Never used at runtime.
 *   workeasy_app        API/worker runtime. NOBYPASSRLS, owns nothing.
 *   workeasy_identity   local identity provider runtime. Privileges on schema "identity" only.
 *   workeasy_reporting  read-only reporting. NOBYPASSRLS (still tenant-scoped).
 *   workeasy_audience_count  NOLOGIN, NOBYPASSRLS. Owns the SECURITY DEFINER functions and triggers that maintain the
 *                       Audience count bitmap (migration 20261013000000_audience_count_bitmap); RLS still confines them
 *                       to the session's workspace. workeasy_owner is a member so migrations can hand it ownership.
 *
 * Also installs, per database, the DDL guard event trigger of the count bitmap (event triggers need a superuser):
 * any DDL that could disable or change bitmap maintenance invalidates every workspace's bitmap.
 *
 * Idempotent: re-running only fills in what is missing. Passwords come from env or are generated and written to .env.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const envPath = resolve(import.meta.dirname, '../../../.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is required (superuser connection used only for bootstrap)');

const ROLES = {
  workeasy_owner: { env: 'DATABASE_OWNER_URL', attrs: 'LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB BYPASSRLS' },
  workeasy_app: { env: 'DATABASE_URL', attrs: 'LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS' },
  workeasy_identity: { env: 'IDENTITY_DATABASE_URL', attrs: 'LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS' },
  workeasy_reporting: { env: 'REPORTING_DATABASE_URL', attrs: 'LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS' },
} as const;
const DATABASES = ['workeasy', 'workeasy_test'];

const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;
const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;

const updates: Record<string, string> = {};
const admin = new URL(adminUrl);

async function main() {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    for (const [role, { env, attrs }] of Object.entries(ROLES)) {
      const existingUrl = process.env[env];
      const password = existingUrl ? decodeURIComponent(new URL(existingUrl).password) : randomBytes(24).toString('base64url');
      const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount;
      const verb = exists ? 'ALTER' : 'CREATE';
      await client.query(`${verb} ROLE ${ident(role)} WITH ${attrs} PASSWORD ${literal(password)}`);
      if (!existingUrl) {
        updates[env] = `postgresql://${role}:${encodeURIComponent(password)}@${admin.host}/workeasy`;
      }
      console.log(`${exists ? "updated" : "created"} role ${role}`);
    }
    // Audience count bitmap maintenance role (no login, no RLS bypass, no inherited privileges).
    const countRole = 'workeasy_audience_count';
    const countExists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [countRole])).rowCount;
    await client.query(`${countExists ? 'ALTER' : 'CREATE'} ROLE ${ident(countRole)} WITH NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOINHERIT`);
    await client.query(`GRANT ${ident(countRole)} TO workeasy_owner`);
    console.log(`${countExists ? 'updated' : 'created'} role ${countRole}`);

    // Runtime safety nets: runaway queries and abandoned transactions are cut off server-side.
    // All timestamps are UTC regardless of the server's local zone (connections also pin this themselves).
    for (const role of Object.keys(ROLES)) await client.query(`ALTER ROLE ${ident(role)} SET timezone = 'UTC'`);
    for (const role of ['workeasy_app', 'workeasy_identity', 'workeasy_reporting']) {
      await client.query(`ALTER ROLE ${ident(role)} SET statement_timeout = '15s'`);
      await client.query(`ALTER ROLE ${ident(role)} SET idle_in_transaction_session_timeout = '30s'`);
    }

    for (const db of DATABASES) {
      const exists = (await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [db])).rowCount;
      if (!exists) {
        await client.query(`CREATE DATABASE ${ident(db)} OWNER workeasy_owner ENCODING 'UTF8' TEMPLATE template0`);
        console.log(`created database ${db}`);
      }
      await client.query(`REVOKE ALL ON DATABASE ${ident(db)} FROM PUBLIC`);
      await client.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${ident(db)} TO workeasy_app, workeasy_identity, workeasy_reporting`);
      await client.query(`GRANT ALL ON DATABASE ${ident(db)} TO workeasy_owner`);

      const dbUrl = new URL(adminUrl);
      dbUrl.pathname = `/${db}`;
      const dbClient = new pg.Client({ connectionString: dbUrl.toString() });
      await dbClient.connect();
      try {
        // Only the owner may create objects in public; everyone else just uses it.
        await dbClient.query('ALTER SCHEMA public OWNER TO workeasy_owner');
        await dbClient.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
        await installCountDdlGuard(dbClient);
      } finally {
        await dbClient.end();
      }
    }
  } finally {
    await client.end();
  }

  if (Object.keys(updates).length) {
    const lines = existsSync(envPath) ? readFileSync(envPath, 'utf8').split(/\r?\n/).filter(Boolean) : [];
    const kept = lines.filter((l) => !Object.keys(updates).some((k) => l.startsWith(`${k}=`)));
    writeFileSync(envPath, [...kept, ...Object.entries(updates).map(([k, v]) => `${k}=${v}`)].join('\n') + '\n');
    console.log(`wrote ${Object.keys(updates).join(', ')} to .env`);
  }
}

/**
 * DDL guard for the Audience count bitmap (G2 condition C2). Disabling, altering or dropping a maintenance trigger, or
 * replacing a maintenance function, would let the bitmap drift while still marked valid; this event trigger marks
 * every workspace's bitmap invalid instead (the exact count then answers until the maintenance job rebuilds it).
 * Owned by workeasy_owner (BYPASSRLS: it must reach every workspace); a no-op until the bitmap tables exist.
 */
async function installCountDdlGuard(c: pg.Client): Promise<void> {
  await c.query(`
    CREATE OR REPLACE FUNCTION public.audience_count_ddl_guard() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    DECLARE r record; hit text;
    BEGIN
      IF to_regclass('public.audience_count_state') IS NULL THEN RETURN; END IF;
      IF TG_EVENT = 'sql_drop' THEN
        FOR r IN SELECT * FROM pg_event_trigger_dropped_objects() LOOP
          IF (r.object_type = 'trigger' AND r.object_name LIKE 'audience_count_%')
             OR (r.object_type = 'function' AND r.schema_name = 'app' AND r.object_identity LIKE 'app.audience_count_%')
             OR (r.object_type = 'table' AND r.schema_name = 'public'
                 AND r.object_name IN ('contacts', 'list_memberships', 'contact_tags', 'audience_count_contact_seq', 'audience_count_source_chunks', 'audience_count_dead_chunks')) THEN
            hit := r.object_type || ' ' || r.object_identity;
          END IF;
        END LOOP;
      ELSE
        FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
          IF (r.classid = 'pg_class'::regclass AND r.objid IN (
                'public.contacts'::regclass, 'public.list_memberships'::regclass, 'public.contact_tags'::regclass,
                'public.audience_count_contact_seq'::regclass, 'public.audience_count_source_chunks'::regclass, 'public.audience_count_dead_chunks'::regclass))
             OR (r.classid = 'pg_proc'::regclass AND r.schema_name = 'app' AND r.object_identity LIKE 'app.audience_count_%')
             OR (r.classid = 'pg_trigger'::regclass AND r.object_identity LIKE 'audience_count_%') THEN
            hit := r.command_tag || ' ' || r.object_identity;
          END IF;
        END LOOP;
      END IF;
      IF hit IS NOT NULL THEN
        UPDATE public.audience_count_state
           SET state = 'invalid', generation = generation + 1, reason = left('DDL: ' || hit, 500),
               rebuild_token = NULL, rebuild_lease_until = NULL, changed_at = now();
      END IF;
    END $$`);
  await c.query(`ALTER FUNCTION public.audience_count_ddl_guard() OWNER TO workeasy_owner`);
  await c.query(`REVOKE ALL ON FUNCTION public.audience_count_ddl_guard() FROM PUBLIC`);
  for (const [name, event, tags] of [
    ['audience_count_ddl_guard', 'ddl_command_end', `'ALTER TABLE', 'CREATE TRIGGER', 'ALTER TRIGGER', 'CREATE FUNCTION', 'ALTER FUNCTION'`],
    ['audience_count_drop_guard', 'sql_drop', `'DROP TRIGGER', 'DROP FUNCTION', 'DROP TABLE', 'ALTER TABLE'`],
  ] as const) {
    await c.query(`DROP EVENT TRIGGER IF EXISTS ${name}`);
    await c.query(`CREATE EVENT TRIGGER ${name} ON ${event} WHEN TAG IN (${tags}) EXECUTE FUNCTION public.audience_count_ddl_guard()`);
  }
}

await main();
