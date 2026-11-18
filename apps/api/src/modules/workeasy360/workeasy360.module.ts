import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { Workeasy360SignInService } from './sign-in.service.js';
import { Workeasy360Controller } from './workeasy360.controller.js';

/**
 * Sign-in with WorkEasy360 Accounts (docs/workeasy360-sso.md): the start/callback/back-channel routes. The runtime
 * (OIDC client + entitlement cache, or null when off) is the global WORKEASY360_RUNTIME provider, because the
 * authentication and access guards consult it on every request.
 */
@Module({
  imports: [IdentityModule, TenancyModule],
  controllers: [Workeasy360Controller],
  providers: [Workeasy360SignInService],
})
export class Workeasy360Module {}
