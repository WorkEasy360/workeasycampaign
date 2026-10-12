import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type Database, isUniqueViolation, type Tx } from '@workeasy/db';
import type { CreateSenderIdentityRequest, CreateSendingDomainRequest, SenderIdentityView, SendingDomainView, UpdateSenderIdentityRequest } from '@workeasy/shared';
import { Errors } from '../../../common/errors.js';
import type { TenantRequestContext } from '../../../common/request-context.js';
import type { AppConfig } from '../../../config/env.js';
import { APP_CONFIG, DATABASE } from '../../../infrastructure/providers.js';
import { inTenant } from '../../tenancy/application/tenant-tx.js';
import { checkDomain, type DnsResolver, dnsGuidance, type DomainChecks, nextDomainStatus, normalizeDomain } from '../domain/deliverability.js';
import { DNS_RESOLVER } from '../infrastructure/node-dns-resolver.js';

type DomainRow = { id: string; domain: string; status: string; checks: unknown; checkedAt: Date | null; verifiedAt: Date | null; verificationToken: string; version: number; createdAt: Date };
type IdentityRow = { id: string; domainId: string; localPart: string; displayName: string; replyTo: string | null; version: number; createdAt: Date };

/**
 * Sending domains and sender identities (Phase 7.8b; campaign amendment §S). Verification is real DNS through the
 * resolver port; the stored status changes only from recorded checks. Workspace-owned rows under forced RLS; every
 * change audited. Campaigns refer to an identity by id; readiness requires its domain to be verified.
 */
@Injectable()
export class SendersService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
  ) {}

  async listDomains(ctx: TenantRequestContext): Promise<SendingDomainView[]> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      const rows = await tx.sendingDomain.findMany({ where: { deletedAt: null }, orderBy: { domain: 'asc' }, take: 200 });
      return Promise.all(rows.map((r) => this.domainView(tx, r)));
    });
  }

  async createDomain(ctx: TenantRequestContext, input: CreateSendingDomainRequest): Promise<SendingDomainView> {
    const domain = normalizeDomain(input.domain);
    if (!domain) throw Errors.validation({ domain: ['Enter a public domain you control, e.g. mail.example.com'] });
    try {
      return await inTenant(this.db, ctx, async ({ tx, audit }) => {
        const row = await tx.sendingDomain.create({
          data: { orgId: ctx.access.orgId, workspaceId: ctx.access.workspaceId!, domain, domainKey: domain, verificationToken: randomBytes(24).toString('base64url'), createdByUserId: ctx.principal.userId },
        });
        await audit({ action: 'sending_domain.created', targetType: 'sending_domain', targetId: row.id, metadata: { domain } });
        return this.domainView(tx, row);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw Errors.conflict('This domain is already added', { domain: ['Already added'] });
      throw err;
    }
  }

  /** Runs the DNS checks now and records them; the status follows the checks (an outage never downgrades). */
  async verifyDomain(ctx: TenantRequestContext, id: string): Promise<SendingDomainView> {
    const row = await inTenant(this.db, ctx, async ({ tx }) => requireDomain(tx, id));
    const checks = await checkDomain(row.domain, row.verificationToken, this.config.deliveryDns, this.dns);
    return inTenant(this.db, ctx, async ({ tx, audit }) => {
      const current = await requireDomain(tx, id);
      const status = nextDomainStatus(current.status as 'pending' | 'verified' | 'failed', checks);
      const now = new Date();
      await tx.sendingDomain.update({
        where: { id },
        data: { checks: checks as object, checkedAt: now, status, verifiedAt: status === 'verified' ? (current.verifiedAt ?? now) : null, updatedAt: now, version: { increment: 1 } },
      });
      if (status !== current.status) await audit({ action: 'sending_domain.status_changed', targetType: 'sending_domain', targetId: id, metadata: { from: current.status, to: status, ...checks } });
      return this.domainView(tx, await requireDomain(tx, id));
    });
  }

  async deleteDomain(ctx: TenantRequestContext, id: string): Promise<void> {
    await inTenant(this.db, ctx, async ({ tx, audit }) => {
      const d = await requireDomain(tx, id);
      if (await tx.senderIdentity.count({ where: { domainId: id, deletedAt: null } })) throw Errors.precondition('Delete the sender identities on this domain first');
      await tx.sendingDomain.update({ where: { id }, data: { deletedAt: new Date(), domainKey: null, updatedAt: new Date(), version: { increment: 1 } } });
      await audit({ action: 'sending_domain.deleted', targetType: 'sending_domain', targetId: id, metadata: { domain: d.domain } });
    });
  }

  async listIdentities(ctx: TenantRequestContext): Promise<SenderIdentityView[]> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      const rows = await tx.senderIdentity.findMany({ where: { deletedAt: null }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: 500 });
      const domains = await domainsById(tx, rows.map((r) => r.domainId));
      return rows.map((r) => identityView(r, domains.get(r.domainId)!));
    });
  }

  async createIdentity(ctx: TenantRequestContext, input: CreateSenderIdentityRequest): Promise<SenderIdentityView> {
    try {
      return await inTenant(this.db, ctx, async ({ tx, audit }) => {
        const domain = await requireDomain(tx, input.domainId);
        const row = await tx.senderIdentity.create({
          data: {
            orgId: ctx.access.orgId,
            workspaceId: ctx.access.workspaceId!,
            domainId: domain.id,
            localPart: input.localPart,
            addressKey: `${input.localPart}@${domain.domain}`.toLowerCase(),
            displayName: input.displayName,
            replyTo: input.replyTo ?? null,
            createdByUserId: ctx.principal.userId,
          },
        });
        await audit({ action: 'sender_identity.created', targetType: 'sender_identity', targetId: row.id, metadata: { domainId: domain.id } });
        return identityView(row, domain);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw Errors.conflict('This sender address already exists', { localPart: ['Already exists'] });
      throw err;
    }
  }

  async updateIdentity(ctx: TenantRequestContext, id: string, input: UpdateSenderIdentityRequest): Promise<SenderIdentityView> {
    return inTenant(this.db, ctx, async ({ tx, audit }) => {
      const row = await requireIdentity(tx, id);
      if (row.version !== input.expectedVersion) throw Errors.versionConflict();
      const r = await tx.senderIdentity.updateMany({
        where: { id, version: input.expectedVersion, deletedAt: null },
        data: {
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
          updatedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (r.count !== 1) throw Errors.versionConflict();
      await audit({ action: 'sender_identity.updated', targetType: 'sender_identity', targetId: id });
      const updated = await requireIdentity(tx, id);
      return identityView(updated, (await domainsById(tx, [updated.domainId])).get(updated.domainId)!);
    });
  }

  async deleteIdentity(ctx: TenantRequestContext, id: string): Promise<void> {
    await inTenant(this.db, ctx, async ({ tx, audit }) => {
      await requireIdentity(tx, id);
      await tx.senderIdentity.update({ where: { id }, data: { deletedAt: new Date(), addressKey: null, updatedAt: new Date(), version: { increment: 1 } } });
      await audit({ action: 'sender_identity.deleted', targetType: 'sender_identity', targetId: id });
    });
  }

  private async domainView(tx: Tx, r: DomainRow): Promise<SendingDomainView> {
    return {
      id: r.id,
      domain: r.domain,
      status: r.status as SendingDomainView['status'],
      checks: r.checkedAt ? (r.checks as DomainChecks) : null,
      checkedAt: r.checkedAt?.toISOString() ?? null,
      verifiedAt: r.verifiedAt?.toISOString() ?? null,
      records: dnsGuidance(r.domain, r.verificationToken, this.config.deliveryDns).map((x) => ({ ...x })),
      identityCount: await tx.senderIdentity.count({ where: { domainId: r.id, deletedAt: null } }),
      version: r.version,
      createdAt: r.createdAt.toISOString(),
    };
  }
}

async function requireDomain(tx: Tx, id: string) {
  const r = await tx.sendingDomain.findFirst({ where: { id, deletedAt: null } });
  if (!r) throw Errors.notFound('Sending domain');
  return r;
}
async function requireIdentity(tx: Tx, id: string) {
  const r = await tx.senderIdentity.findFirst({ where: { id, deletedAt: null } });
  if (!r) throw Errors.notFound('Sender identity');
  return r;
}
async function domainsById(tx: Tx, ids: string[]) {
  const rows = await tx.sendingDomain.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, domain: true, status: true } });
  return new Map(rows.map((r) => [r.id, r]));
}
function identityView(r: IdentityRow, d: { domain: string; status: string }): SenderIdentityView {
  return { id: r.id, domainId: r.domainId, email: `${r.localPart}@${d.domain}`, displayName: r.displayName, replyTo: r.replyTo, verified: d.status === 'verified', version: r.version, createdAt: r.createdAt.toISOString() };
}

/** For readiness and delivery: the identity (live) and whether its domain is verified; null when unknown/deleted. */
export async function senderIdentityState(tx: Tx, id: string): Promise<{ email: string; displayName: string; replyTo: string | null; verified: boolean } | null> {
  const r = await tx.senderIdentity.findFirst({ where: { id, deletedAt: null } });
  if (!r) return null;
  const d = await tx.sendingDomain.findFirst({ where: { id: r.domainId, deletedAt: null }, select: { domain: true, status: true } });
  if (!d) return null;
  return { email: `${r.localPart}@${d.domain}`, displayName: r.displayName, replyTo: r.replyTo, verified: d.status === 'verified' };
}
