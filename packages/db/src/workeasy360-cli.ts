/**
 * WorkEasy360 operator commands (docs/workeasy360-sso.md §Operator commands). Runs as the schema owner:
 *
 *   node packages/db/dist/workeasy360-cli.js <command> ...        (or: pnpm --filter @workeasy/db workeasy360 <command> ...)
 *
 *   link-organization <organization-id> <workeasy360-organization-id>
 *   unlink-organization <organization-id>
 *   link-user <user-id|email> <workeasy360-sub> [--issuer <issuer>]      (default issuer: WORKEASY360_ISSUER)
 *   move-issuer --from <old issuer> --to <new issuer> [--apply]
 *   identities
 *
 * Connection: DATABASE_OWNER_URL (in development, read from the repository .env).
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { identitiesReport, linkOrganization, linkUser, moveIssuer, OperatorError, unlinkOrganization } from './workeasy360-operator.js';

const USAGE = `usage:
  link-organization <organization-id> <workeasy360-organization-id>
  unlink-organization <organization-id>
  link-user <user-id|email> <workeasy360-sub> [--issuer <issuer>]
  move-issuer --from <old issuer> --to <new issuer> [--apply]
  identities`;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env');
  if (!process.env.DATABASE_OWNER_URL && existsSync(envFile) && process.env.NODE_ENV !== 'production') process.loadEnvFile(envFile);
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) {
    console.error('DATABASE_OWNER_URL is required (the schema owner: these commands are operator actions)');
    return 2;
  }
  const [command, ...args] = argv;
  // Options with a value (--from, --to, --issuer) take the next argument; --apply is a flag.
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--apply') continue;
    if (a.startsWith('--')) i++;
    else positional.push(a);
  }
  const client = new pg.Client({ connectionString: url, application_name: 'workeasy360-operator', options: '-c TimeZone=UTC' });
  await client.connect();
  try {
    switch (command) {
      case 'link-organization': {
        if (positional.length !== 2) break;
        const r = await linkOrganization(client, positional[0]!, positional[1]!);
        console.log(r.changed ? 'linked' : 'already linked; nothing changed');
        return 0;
      }
      case 'unlink-organization': {
        if (positional.length !== 1) break;
        const r = await unlinkOrganization(client, positional[0]!);
        console.log(r.changed ? `unlinked; ${r.sessionsEnded} WorkEasy360 session(s) ended` : 'not linked; nothing changed');
        return 0;
      }
      case 'link-user': {
        if (positional.length !== 2) break;
        const issuer = option(args, '--issuer') ?? process.env.WORKEASY360_ISSUER;
        if (!issuer) {
          console.error('--issuer is required when WORKEASY360_ISSUER is not set');
          return 2;
        }
        const r = await linkUser(client, positional[0]!, positional[1]!, issuer);
        console.log(`user ${r.userId} is now WorkEasy360 subject ${positional[1]} under ${issuer}`);
        return 0;
      }
      case 'move-issuer': {
        const from = option(args, '--from');
        const to = option(args, '--to');
        if (!from || !to) break;
        const r = await moveIssuer(client, from, to, args.includes('--apply'));
        console.log(`${r.identities} identit${r.identities === 1 ? 'y' : 'ies'} and ${r.sessions} live session(s) under ${from}` +
          (r.applied ? ` moved to ${to}` : ` would move to ${to} (dry run: add --apply)`));
        return 0;
      }
      case 'identities': {
        const r = await identitiesReport(client);
        for (const i of r.issuers) console.log(`${i.issuer}\t${i.identities} identities\t${i.liveSessions} live sessions`);
        console.log(`${r.linkedOrganizations} organization(s) linked to WorkEasy360`);
        return 0;
      }
    }
    console.error(USAGE);
    return 2;
  } catch (err) {
    if (err instanceof OperatorError) {
      console.error(`refused: ${err.message}`);
      return 1;
    }
    throw err;
  } finally {
    await client.end();
  }
}

process.exitCode = await main(process.argv.slice(2));
