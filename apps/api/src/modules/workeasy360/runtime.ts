import { readFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import type { Database } from '@workeasy/db';
import { Workeasy360Client } from './client.js';
import { type AnswerStore, EntitlementCache, type EntitlementLogger } from './entitlements.js';
import type { Workeasy360Settings } from './settings.js';

/** Nest token for the WorkEasy360 runtime: `Workeasy360Runtime`, or null when sign-in with WorkEasy360 is off. */
export const WORKEASY360_RUNTIME = Symbol('WORKEASY360_RUNTIME');

export interface Workeasy360Runtime {
  client: Workeasy360Client;
  entitlements: EntitlementCache;
  settings: Workeasy360Settings;
}

export interface Workeasy360RuntimeOptions {
  /** Where entitlement answers are shared; PostgreSQL unless a test gives its own. */
  store?: AnswerStore;
  /** The entitlement cache's clock (tests). Tokens are always checked against the real clock. */
  cacheNow?: () => number;
}

/** Entitlement answers shared by every API instance, in PostgreSQL (migration 20261102000000_workeasy360_sso). */
export function postgresAnswerStore(db: Database): AnswerStore {
  return {
    get: (key) => db.system.workeasy360.getAnswer(key),
    set: (key, value, ttlSeconds) => db.system.workeasy360.putAnswer(key, value, ttlSeconds),
  };
}

function nestLogger(): EntitlementLogger {
  const logger = new Logger('Workeasy360');
  const line = (message: string, facts: Record<string, unknown>) => JSON.stringify({ msg: message, ...facts });
  return {
    info: (facts, message) => logger.log(line(message, facts)),
    warn: (facts, message) => logger.warn(line(message, facts)),
    error: (facts, message) => logger.error(line(message, facts)),
  };
}

/** Builds the runtime at boot. An unreadable private key fails boot (its content is never logged). */
export function createWorkeasy360Runtime(settings: Workeasy360Settings, db: Database, options: Workeasy360RuntimeOptions = {}): Workeasy360Runtime {
  let privateKeyPem: string;
  try {
    privateKeyPem = readFileSync(settings.privateKeyFile, 'utf8');
  } catch {
    throw new Error(`WORKEASY360_PRIVATE_KEY_FILE: cannot read ${settings.privateKeyFile}`);
  }
  const client = new Workeasy360Client({
    issuer: settings.issuer,
    clientId: settings.clientId,
    productCode: settings.productCode,
    redirectUri: settings.redirectUri,
    keyId: settings.keyId,
    privateKeyPem,
    scopes: settings.scopes,
    allowInsecureRequests: settings.allowInsecureRequests,
  });
  return {
    client,
    entitlements: new EntitlementCache(client, options.store ?? postgresAnswerStore(db), nestLogger(), options.cacheNow),
    settings,
  };
}
