import { createIdentityStore } from '@workeasy/db/identity';
import type { AppConfig } from '../../../../config/env.js';
import { APP_CONFIG } from '../../../../infrastructure/providers.js';
import { IDENTITY_STORE } from './local-identity.provider.js';

/** The only place the identity-schema connection (role workeasy_identity) is created. */
export const identityStoreProvider = {
  provide: IDENTITY_STORE,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig) => createIdentityStore(config.identityDatabaseUrl),
};
