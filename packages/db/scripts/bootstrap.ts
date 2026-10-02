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
      console.log(`${verb.toLowerCase()}d role ${role}`);
    }
    // Runtime safety nets: runaway queries and abandoned transactions are cut off server-side.
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

await main();
