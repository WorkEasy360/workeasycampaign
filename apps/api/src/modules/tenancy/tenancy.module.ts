import { Module } from '@nestjs/common';
import { IdempotencyService } from '../../common/idempotency.js';
import { AuditController } from '../audit/audit.controller.js';
import { AuditQueryService } from '../audit/audit-query.service.js';
import { IdentityModule } from '../identity/identity.module.js';
import { AccessService } from './application/access.service.js';
import { ContextService } from './application/context.service.js';
import { InvitationsService } from './application/invitations.service.js';
import { MembersService } from './application/members.service.js';
import { OrganizationsService } from './application/organizations.service.js';
import { RolesService } from './application/roles.service.js';
import { WorkspacesService } from './application/workspaces.service.js';
import { AccessGuard } from './http/access.guard.js';
import {
  InvitationsPublicController,
  OrganizationMembersController,
  OrganizationsController,
  WorkspacesController,
} from './http/tenancy.controllers.js';

@Module({
  imports: [IdentityModule],
  controllers: [
    OrganizationsController,
    WorkspacesController,
    OrganizationMembersController,
    InvitationsPublicController,
    AuditController,
  ],
  providers: [
    AccessService,
    AccessGuard,
    ContextService,
    OrganizationsService,
    WorkspacesService,
    MembersService,
    InvitationsService,
    RolesService,
    AuditQueryService,
    IdempotencyService,
  ],
  exports: [AccessService, AccessGuard],
})
export class TenancyModule {}
