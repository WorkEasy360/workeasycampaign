import { Inject, Injectable } from '@nestjs/common';
import { canonicalContentV3, contentIssuesV3 } from '@workeasy/content';
import { type Database, isUniqueViolation, type Tx } from '@workeasy/db';
import {
  type CreateSnippetRequest,
  type EmailContentV3Draft,
  type SnippetListItem,
  type SnippetListQuery,
  type SnippetView,
  snippetContentSchema,
  type UpdateSnippetRequest,
} from '@workeasy/shared';
import { AppError, Errors } from '../../../common/errors.js';
import { cursorScope, decodeCursor, encodeCursor } from '../../../common/pagination.js';
import type { TenantRequestContext } from '../../../common/request-context.js';
import { DATABASE } from '../../../infrastructure/providers.js';
import { inTenant } from '../../tenancy/application/tenant-tx.js';
import { actorsById } from './campaign-views.js';

const nameKey = (name: string) => name.trim().toLowerCase();
const snippetNotFound = () => Errors.notFound('Saved block');
const nameTaken = () => Errors.conflict('A saved block with this name already exists', { name: ['Choose another name'] });

type Blocks = EmailContentV3Draft['body']['blocks'];

/**
 * Reusable saved blocks (docs/contracts/phase-7-content-amendment.md §S). Workspace-owned rows under forced RLS,
 * validated with the v3 content rules on write AND read; stored canonical. Changes are audited, reads are not.
 * Inserting a snippet into a message is a client-side copy (fresh ids) followed by the ordinary draft update, so every
 * draft rule, permission and readiness check applies to the result.
 */
@Injectable()
export class SnippetsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(ctx: TenantRequestContext, q: SnippetListQuery): Promise<{ data: SnippetListItem[]; nextCursor: string | null }> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      const scope = cursorScope(ctx.access, 'snippets', { q: q.q });
      const c = decodeCursor(q.cursor, scope);
      const rows = await tx.emailSnippet.findMany({
        where: {
          deletedAt: null,
          ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
          ...(c ? { OR: [{ updatedAt: { lt: new Date(c.t) } }, { updatedAt: new Date(c.t), id: { lt: c.id } }] } : {}),
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        data: page.map((r) => ({ id: r.id, name: r.name, blockCount: readBlocks(r.content).length, version: r.version, updatedAt: r.updatedAt.toISOString() })),
        nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.updatedAt.toISOString(), id: last.id }, scope) : null,
      };
    });
  }

  async get(ctx: TenantRequestContext, id: string): Promise<SnippetView> {
    return inTenant(this.db, ctx, async ({ tx }) => this.view(tx, await requireSnippet(tx, id)));
  }

  async create(ctx: TenantRequestContext, input: CreateSnippetRequest): Promise<SnippetView> {
    const blocks = canonicalBlocks(input.blocks);
    try {
      return await inTenant(this.db, ctx, async ({ tx, audit }) => {
        const row = await tx.emailSnippet.create({
          data: {
            orgId: ctx.access.orgId,
            workspaceId: ctx.access.workspaceId!,
            name: input.name,
            nameKey: nameKey(input.name),
            content: { schema: 'email.snippet.v1', blocks },
            createdByUserId: ctx.principal.userId,
          },
        });
        await audit({ action: 'snippet.created', targetType: 'snippet', targetId: row.id, metadata: { blocks: blocks.length } });
        return this.view(tx, row);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
  }

  async update(ctx: TenantRequestContext, id: string, input: UpdateSnippetRequest): Promise<SnippetView> {
    const blocks = input.blocks ? canonicalBlocks(input.blocks) : undefined;
    try {
      return await inTenant(this.db, ctx, async ({ tx, audit }) => {
        const row = await requireSnippet(tx, id);
        if (row.version !== input.expectedVersion) throw Errors.versionConflict();
        const changes = [
          ...(input.name !== undefined && input.name !== row.name ? ['name'] : []),
          ...(blocks && JSON.stringify(blocks) !== JSON.stringify(readBlocks(row.content)) ? ['blocks'] : []),
        ];
        if (!changes.length) return this.view(tx, row);
        const r = await tx.emailSnippet.updateMany({
          where: { id, version: input.expectedVersion, deletedAt: null },
          data: {
            ...(input.name !== undefined ? { name: input.name, nameKey: nameKey(input.name) } : {}),
            ...(blocks ? { content: { schema: 'email.snippet.v1', blocks } } : {}),
            updatedAt: new Date(),
            version: { increment: 1 },
          },
        });
        if (r.count !== 1) throw Errors.versionConflict();
        await audit({ action: 'snippet.updated', targetType: 'snippet', targetId: id, metadata: { changes: changes.join(',') } });
        return this.view(tx, await requireSnippet(tx, id));
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
  }

  async delete(ctx: TenantRequestContext, id: string): Promise<void> {
    await inTenant(this.db, ctx, async ({ tx, audit }) => {
      await requireSnippet(tx, id);
      await tx.emailSnippet.update({ where: { id }, data: { deletedAt: new Date(), nameKey: null, updatedAt: new Date(), version: { increment: 1 } } });
      await audit({ action: 'snippet.deleted', targetType: 'snippet', targetId: id });
    });
  }

  private async view(tx: Tx, row: { id: string; name: string; content: unknown; version: number; createdAt: Date; updatedAt: Date; createdByUserId: string | null }): Promise<SnippetView> {
    const actors = await actorsById(tx, [row.createdByUserId]);
    return {
      id: row.id,
      name: row.name,
      blocks: readBlocks(row.content),
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      createdBy: row.createdByUserId ? (actors.get(row.createdByUserId) ?? null) : null,
    };
  }
}

async function requireSnippet(tx: Tx, id: string) {
  const row = await tx.emailSnippet.findFirst({ where: { id, deletedAt: null } });
  if (!row) throw snippetNotFound();
  return row;
}

/**
 * The v3 content rules applied to the blocks alone (wrapped in a content with a placeholder subject): 422 with one
 * field error per problem, keyed "blocks/…". The stored form is canonical (e.g. HTML normalized).
 */
function canonicalBlocks(blocks: Blocks): Blocks {
  const content: EmailContentV3Draft = { schema: 'email.content.v3', subject: 'Saved block', preheader: '', body: { format: 'blocks', blocks } };
  const issues = contentIssuesV3(content).filter((i) => i.pointer.startsWith('/body'));
  if (issues.length) {
    const fields: Record<string, string[]> = {};
    for (const i of issues) (fields[i.pointer === '/body' ? 'blocks' : `blocks${i.pointer.slice('/body/blocks'.length)}`] ??= []).push(i.message);
    throw new AppError('validation_failed', 422, 'Fix the blocks before saving them', fields);
  }
  return canonicalContentV3(content)!.body.blocks;
}

/** Validated on read: a stored row that does not parse is a defect surfaced loudly, never served. */
function readBlocks(raw: unknown): Blocks {
  return snippetContentSchema.parse(raw).blocks;
}
