import { createDatabase, type Database } from '@workeasy/db';
import type { AppConfig } from '../config/env.js';

export const APP_CONFIG = Symbol('APP_CONFIG');
export const DATABASE = Symbol('DATABASE');

export function databaseFactory(config: AppConfig): Database {
  return createDatabase({ url: config.databaseUrl, maxConnections: 10, applicationName: 'workeasy-api' });
}
