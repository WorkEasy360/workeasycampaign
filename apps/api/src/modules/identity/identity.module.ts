import { Module } from '@nestjs/common';
import { AuthenticationService } from './application/authentication.service.js';
import { IDENTITY_PROVIDER } from './application/identity-provider.js';
import { SessionService } from './application/session.service.js';
import { AuthController } from './http/auth.controller.js';
import { MeController } from './http/me.controller.js';
import { identityStoreProvider } from './infrastructure/local/identity-store.provider.js';
import { LocalIdentityProvider } from './infrastructure/local/local-identity.provider.js';

/**
 * Identity: providers, platform sessions, the signed-in user's account.
 * The configured provider is bound to IDENTITY_PROVIDER; switching to Workeasy SSO changes this binding
 * (and removes the local-only endpoints), not the rest of the platform.
 */
@Module({
  controllers: [AuthController, MeController],
  providers: [
    identityStoreProvider,
    LocalIdentityProvider,
    { provide: IDENTITY_PROVIDER, useExisting: LocalIdentityProvider },
    SessionService,
    AuthenticationService,
  ],
  exports: [AuthenticationService, SessionService],
})
export class IdentityModule {}
