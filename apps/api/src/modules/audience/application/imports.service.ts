import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { type Database, DbNull, type Tx } from '@workeasy/db';
import type { ImportIssueView, ImportMappingRequest, ImportOptions, ImportPreview, ImportSummaryCounts, ImportView } from '@workeasy/shared';
import { v7 as uuidv7 } from 'uuid';
import { AppError, Errors } from '../../../common/errors.js';
import { JOB_DISPATCHER, type JobDispatcher } from '../../../common/jobs.js';
import { decodeCursor, encodeCursor } from '../../../common/pagination.js';
import type { TenantRequestContext } from '../../../common/request-context.js';
import type { AppConfig } from '../../../config/env.js';
import { FILE_STORE, type FileStore } from '../../../infrastructure/files/file-store.js';
import { APP_CONFIG, DATABASE } from '../../../infrastructure/providers.js';
import { inTenant } from '../../tenancy/application/tenant-tx.js';
import { csvSafe, suggestMapping } from '../domain/import-decision.js';
import { detectDelimiter, inspectCsv, readHead, readRows, sanitizeFileName } from '../infrastructure/csv.js';
import { ImportProcessor, type ImportJob, importStorageKey } from './import-processor.js';

export const IMPORT_JOB = 'contacts.import';
/** A "processing" import untouched for this long is considered stalled (e.g. the API restarted) and may be retried. */
export const STALLED_AFTER_MS = 5 * 60_000;
/** Imports holding a file (uploaded, validated, processing, failed) per workspace. Bounds disk use (finding M-4). */
export const MAX_OPEN_IMPORTS = 10;
/** Abandoned uploads (never started) are cancelled and their file deleted after this long. */
export const ABANDONED_AFTER_MS = 24 * 3600_000;
/** Failed imports keep their file for retry this long, then are cancelled and the file deleted. */
export const FAILED_KEPT_MS = 7 * 24 * 3600_000;
const OPEN_STATUSES = ['uploaded', 'validated', 'processing', 'failed'];

/**
 * Import options act on lists, tags, topics and consent. contacts.import alone must not grant those: each option
 * needs the permission the equivalent direct action needs (finding M-3; built-in roles already pair them, custom
 * roles may not).
 */
export function optionPermissionProblems(permissions: ReadonlySet<string>, options: Partial<ImportOptions>): Record<string, string[]> {
  const problems: Record<string, string[]> = {};
  if (options.listIds?.length && !permissions.has('lists.manage')) problems['options.listIds'] = ['Adding contacts to lists needs the lists.manage permission'];
  if (options.tagIds?.length && !permissions.has('tags.manage')) problems['options.tagIds'] = ['Tagging contacts needs the tags.manage permission'];
  if (options.topicIds?.length && !permissions.has('consent.manage')) problems['options.topicIds'] = ['Subscribing contacts to topics needs the consent.manage permission'];
  if (options.consent && !permissions.has('consent.manage')) problems['options.consent'] = ['Recording consent needs the consent.manage permission'];
  return problems;
}

function assertOptionPermissions(permissions: ReadonlySet<string>, options: Partial<ImportOptions>) {
  const denied = optionPermissionProblems(permissions, options);
  if (Object.keys(denied).length) throw new AppError('forbidden', 403, 'You do not have permission for some import options', denied);
}

type ImportRow = {
  id: string;
  status: string;
  fileName: string;
  fileSize: number;
  headers: unknown;
  mapping: unknown;
  options: unknown;
  totalRows: number | null;
  processedRows: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  dryRunSummary: unknown;
  failureReason: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
  version: number;
  workspaceId: string;
  delimiter: string;
};

@Injectable()
export class ImportsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(FILE_STORE) private readonly files: FileStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(JOB_DISPATCHER) private readonly jobs: JobDispatcher,
    private readonly processor: ImportProcessor,
  ) {}

  /** Stores the upload (size/encoding checked while streaming), validates the CSV, and records the import. */
  async upload(ctx: TenantRequestContext, fileName: string | undefined, body: Readable): Promise<ImportView> {
    const id = uuidv7();
    const workspaceId = ctx.access.workspaceId!;
    await this.expireStale(ctx);
    const open = await inTenant(this.db, ctx, ({ tx }) => tx.contactImport.count({ where: { status: { in: OPEN_STATUSES } } }));
    if (open >= MAX_OPEN_IMPORTS) {
      body.resume(); // discard the upload so the client receives the error instead of a reset connection
      throw new AppError('conflict', 409, `This workspace already has ${MAX_OPEN_IMPORTS} unfinished imports. Finish or cancel one first.`, { file: ['TOO_MANY_OPEN_IMPORTS'] });
    }
    const key = importStorageKey(workspaceId, id);
    const stored = await this.files.save(key, body, { maxBytes: this.config.imports.maxBytes, validateUtf8: true });
    try {
      if (stored.size === 0) throw new AppError('validation_failed', 400, 'The file is empty', { file: ['EMPTY_FILE'] });
      const delimiter = detectDelimiter((await readHead(this.files.open(key))).split(/\r?\n/)[0] ?? '');
      const { headers, totalRows } = await inspectCsv(this.files.open(key), delimiter, this.config.imports.maxRows);
      return await inTenant(this.db, ctx, async ({ tx }) => {
        const fields = await tx.customFieldDefinition.findMany({ select: { key: true, label: true, status: true } });
        const row = await tx.contactImport.create({
          data: {
            id,
            orgId: ctx.access.orgId,
            workspaceId,
            fileName: sanitizeFileName(fileName),
            fileSize: stored.size,
            fileSha256: stored.sha256,
            delimiter,
            headers,
            totalRows,
            mapping: suggestMapping(headers, fields),
            createdByUserId: ctx.principal.userId,
          },
        });
        return this.view(row);
      });
    } catch (err) {
      await this.files.remove(key);
      throw err;
    }
  }

  async list(ctx: TenantRequestContext, limit: number, cursor?: string) {
    await this.expireStale(ctx);
    return inTenant(this.db, ctx, async ({ tx }) => {
      const c = decodeCursor(cursor);
      const rows = await tx.contactImport.findMany({
        where: c ? { OR: [{ createdAt: { lt: new Date(c.t) } }, { createdAt: new Date(c.t), id: { lt: c.id } }] } : {},
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return { data: page.map((r) => this.view(r)), nextCursor: rows.length > limit && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null };
    });
  }

  async get(ctx: TenantRequestContext, importId: string): Promise<ImportView> {
    return inTenant(this.db, ctx, async ({ tx }) => this.view(await this.require(tx, importId)));
  }

  async preview(ctx: TenantRequestContext, importId: string): Promise<ImportPreview> {
    const imp = await inTenant(this.db, ctx, ({ tx }) => this.require(tx, importId));
    if (!this.hasFile(imp.status)) throw Errors.precondition('The uploaded file is no longer available for this import');
    const rows: string[][] = [];
    for await (const r of readRows(this.files.open(importStorageKey(imp.workspaceId, importId)), imp.delimiter)) {
      rows.push(r.cells.map((c) => c.slice(0, 200)));
      if (rows.length === 10) break;
    }
    const fields = await inTenant(this.db, ctx, ({ tx }) => tx.customFieldDefinition.findMany({ select: { key: true, label: true, status: true } }));
    const headers = imp.headers as string[];
    return { headers, rows, suggestedMapping: suggestMapping(headers, fields) };
  }

  async setMapping(ctx: TenantRequestContext, importId: string, input: ImportMappingRequest): Promise<ImportView> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      const imp = await this.require(tx, importId);
      if (imp.status !== 'uploaded' && imp.status !== 'validated') throw Errors.precondition('The mapping can only change before the import starts');
      assertOptionPermissions(ctx.access.permissions, input.options);
      await this.validateMapping(tx, imp.headers as string[], input);
      const r = await tx.contactImport.updateMany({
        where: { id: importId, version: input.version },
        data: { mapping: input.mapping, options: input.options, status: 'uploaded', dryRunSummary: DbNull, updatedAt: new Date(), version: { increment: 1 } },
      });
      if (r.count !== 1) throw Errors.versionConflict();
      await tx.contactImportIssue.deleteMany({ where: { importId, phase: 'dry_run' } });
      return this.view(await this.require(tx, importId));
    });
  }

  async dryRun(ctx: TenantRequestContext, importId: string): Promise<ImportView> {
    const imp = await inTenant(this.db, ctx, ({ tx }) => this.require(tx, importId));
    if (imp.status !== 'uploaded' && imp.status !== 'validated') throw Errors.precondition('A dry run is only possible before the import starts');
    this.assertMapped(imp);
    const summary: ImportSummaryCounts = await this.processor.dryRun(ctx, importId);
    return inTenant(this.db, ctx, async ({ tx }) => {
      await tx.contactImport.update({ where: { id: importId }, data: { dryRunSummary: summary as object, status: 'validated', updatedAt: new Date(), version: { increment: 1 } } });
      return this.view(await this.require(tx, importId));
    });
  }

  /** Starts the import. Requires a dry run first, so nobody imports a file blind. */
  async start(ctx: TenantRequestContext, importId: string): Promise<ImportView> {
    const view = await inTenant(this.db, ctx, async ({ tx, event, audit }) => {
      const imp = await this.require(tx, importId);
      if (imp.status !== 'validated') throw Errors.precondition('Run a dry run first, review the result, then start the import');
      // Permissions may have changed since the mapping was saved; lists, tags or topics may have been archived since.
      assertOptionPermissions(ctx.access.permissions, imp.options as Partial<ImportOptions>);
      await this.validateMapping(tx, imp.headers as string[], { mapping: imp.mapping as Record<string, string>, options: imp.options as ImportOptions, version: imp.version });
      await this.assertNoOtherRunning(tx, imp.workspaceId, importId);
      await tx.contactImport.update({ where: { id: importId }, data: { status: 'processing', startedAt: new Date(), updatedAt: new Date(), version: { increment: 1 } } });
      await event('import.started', importId, { totalRows: imp.totalRows });
      await audit({ action: 'import.started', targetType: 'import', targetId: importId, metadata: { fileName: imp.fileName, totalRows: imp.totalRows, sha256: (imp as { fileSha256?: string }).fileSha256 } });
      return this.view(await this.require(tx, importId));
    });
    this.dispatch(ctx, importId);
    return view;
  }

  /** Resumes a failed (or stalled) import from its last committed chunk. */
  async retry(ctx: TenantRequestContext, importId: string): Promise<ImportView> {
    const view = await inTenant(this.db, ctx, async ({ tx }) => {
      const imp = await this.require(tx, importId);
      const stalled = imp.status === 'processing' && Date.now() - imp.updatedAt.getTime() > STALLED_AFTER_MS;
      if (imp.status !== 'failed' && !stalled) throw Errors.precondition('Only a failed or stalled import can be retried');
      assertOptionPermissions(ctx.access.permissions, imp.options as Partial<ImportOptions>);
      await this.assertNoOtherRunning(tx, imp.workspaceId, importId);
      await tx.contactImport.update({ where: { id: importId }, data: { status: 'processing', failureReason: null, updatedAt: new Date(), version: { increment: 1 } } });
      return this.view(await this.require(tx, importId));
    });
    this.dispatch(ctx, importId);
    return view;
  }

  async cancel(ctx: TenantRequestContext, importId: string): Promise<ImportView> {
    return inTenant(this.db, ctx, async ({ tx, audit }) => {
      const imp = await this.require(tx, importId);
      if (!['uploaded', 'validated', 'processing', 'failed'].includes(imp.status)) throw Errors.precondition('This import has already finished');
      await tx.contactImport.update({ where: { id: importId }, data: { status: 'cancelled', completedAt: new Date(), updatedAt: new Date(), version: { increment: 1 } } });
      await audit({ action: 'import.cancelled', targetType: 'import', targetId: importId, metadata: { processedRows: imp.processedRows } });
      await this.files.remove(importStorageKey(imp.workspaceId, importId));
      return this.view(await this.require(tx, importId));
    });
  }

  async issues(ctx: TenantRequestContext, importId: string, phase: 'dry_run' | 'run', limit: number, cursor?: string) {
    return inTenant(this.db, ctx, async ({ tx }) => {
      await this.require(tx, importId);
      const after = cursor ? Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10) : 0;
      const rows = await tx.contactImportIssue.findMany({
        where: { importId, phase, rowNumber: { gt: Number.isFinite(after) ? after : 0 } },
        orderBy: [{ rowNumber: 'asc' }, { id: 'asc' }],
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        data: page.map((i): ImportIssueView => ({ rowNumber: i.rowNumber, column: i.column, code: i.code, message: i.message, severity: i.severity as ImportIssueView['severity'] })),
        nextCursor: rows.length > limit && last ? Buffer.from(String(last.rowNumber)).toString('base64url') : null,
      };
    });
  }

  /** Issue report as CSV. Values are neutralized against spreadsheet formula injection. */
  async issuesCsv(ctx: TenantRequestContext, importId: string, phase: 'dry_run' | 'run'): Promise<string> {
    return inTenant(this.db, ctx, async ({ tx }) => {
      await this.require(tx, importId);
      const rows = await tx.contactImportIssue.findMany({ where: { importId, phase }, orderBy: [{ rowNumber: 'asc' }, { id: 'asc' }], take: 5000 });
      const lines = rows.map((i) => [i.rowNumber, i.column ?? '', i.severity, i.code, i.message].map(csvSafe).join(','));
      return ['row,column,severity,code,message', ...lines].join('\r\n');
    });
  }

  // ─── internals ────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * One import runs at a time per workspace (finding M-5): concurrent imports of overlapping files would race for
   * the same addresses (one would fail on the unique constraint) and double the load. A transaction-scoped advisory
   * lock serializes the check, so two simultaneous starts cannot both pass.
   */
  private async assertNoOtherRunning(tx: Tx, workspaceId: string, importId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('contact-import:' || ${workspaceId}, 0))`;
    const running = await tx.contactImport.count({ where: { status: 'processing', id: { not: importId } } });
    if (running) {
      throw new AppError('conflict', 409, 'Another import is running in this workspace. Wait for it to finish, or cancel it.', { import: ['IMPORT_IN_PROGRESS'] });
    }
  }

  /**
   * Abandoned and long-failed imports are cancelled and their files deleted (finding M-4). Runs, scoped to the
   * calling workspace, whenever imports are listed or uploaded, so no scheduler is needed for it to happen.
   */
  private async expireStale(ctx: TenantRequestContext) {
    const now = Date.now();
    const stale = await inTenant(this.db, ctx, ({ tx }) =>
      tx.contactImport.findMany({
        where: {
          OR: [
            { status: { in: ['uploaded', 'validated'] }, updatedAt: { lt: new Date(now - ABANDONED_AFTER_MS) } },
            { status: 'failed', updatedAt: { lt: new Date(now - FAILED_KEPT_MS) } },
          ],
        },
        select: { id: true, status: true, workspaceId: true, processedRows: true },
        take: 50,
      }),
    );
    for (const imp of stale) {
      await inTenant(this.db, ctx, async ({ tx, audit }) => {
        const done = await tx.contactImport.updateMany({
          where: { id: imp.id, status: imp.status },
          data: { status: 'cancelled', completedAt: new Date(), updatedAt: new Date(), version: { increment: 1 } },
        });
        if (done.count === 1) {
          await audit({
            action: 'import.cancelled',
            targetType: 'import',
            targetId: imp.id,
            metadata: { processedRows: imp.processedRows, reason: imp.status === 'failed' ? 'failed_expired' : 'abandoned' },
          });
        }
      });
      await this.files.remove(importStorageKey(imp.workspaceId, imp.id));
    }
  }

  private dispatch(ctx: TenantRequestContext, importId: string) {
    const job: ImportJob = {
      tenant: { orgId: ctx.access.orgId, workspaceId: ctx.access.workspaceId! },
      actor: { userId: ctx.principal.userId, email: ctx.principal.email, displayName: ctx.principal.displayName },
      correlationId: ctx.meta.requestId,
      payload: { importId },
    };
    this.jobs.dispatch(IMPORT_JOB, job);
  }

  private hasFile(status: string) {
    return status === 'uploaded' || status === 'validated' || status === 'processing' || status === 'failed';
  }

  private assertMapped(imp: { mapping: unknown; options: unknown }) {
    const targets = Object.values(imp.mapping as Record<string, string>);
    if (!targets.some((t) => t === 'email' || t === 'phone' || t === 'whatsapp') || !(imp.options as Partial<ImportOptions>).mode) {
      throw Errors.precondition('Confirm the column mapping first');
    }
  }

  private async validateMapping(tx: Tx, headers: string[], input: ImportMappingRequest) {
    const errors: Record<string, string[]> = {};
    const used = new Map<string, string>();
    for (const [col, target] of Object.entries(input.mapping)) {
      if (Number(col) >= headers.length) (errors[`mapping.${col}`] ??= []).push('No such column');
      if (target === 'ignore') continue;
      if (used.has(target)) (errors[`mapping.${col}`] ??= []).push(`"${target}" is already mapped to "${headers[Number(used.get(target))]}"`);
      used.set(target, col);
    }
    const targets = [...used.keys()];
    if (!targets.some((t) => t === 'email' || t === 'phone' || t === 'whatsapp')) errors.mapping = ['Map at least one email, phone or WhatsApp column'];
    const cfKeys = targets.filter((t) => t.startsWith('cf:')).map((t) => t.slice(3));
    if (cfKeys.length) {
      const defs = await tx.customFieldDefinition.findMany({ where: { key: { in: cfKeys }, status: 'active' }, select: { key: true } });
      for (const k of cfKeys) if (!defs.some((d) => d.key === k)) (errors.mapping ??= []).push(`Custom field "${k}" does not exist or is archived`);
    }
    const o = input.options;
    if (o.listIds.length && (await tx.contactList.count({ where: { id: { in: o.listIds }, deletedAt: null, status: 'active' } })) !== new Set(o.listIds).size) {
      errors['options.listIds'] = ['One or more lists are not available'];
    }
    if (o.tagIds.length && (await tx.tag.count({ where: { id: { in: o.tagIds }, deletedAt: null } })) !== new Set(o.tagIds).size) {
      errors['options.tagIds'] = ['One or more tags are not available'];
    }
    if (o.topicIds.length && (await tx.topic.count({ where: { id: { in: o.topicIds }, kind: 'topic', status: 'active' } })) !== new Set(o.topicIds).size) {
      errors['options.topicIds'] = ['One or more topics are not available'];
    }
    if (o.consent) {
      const needed = o.consent.channel === 'email' ? 'email' : o.consent.channel === 'sms' ? 'phone' : 'whatsapp';
      if (!targets.includes(needed)) errors['options.consent'] = [`Recording ${o.consent.channel} consent needs a mapped ${needed} column`];
    }
    if (Object.keys(errors).length) throw Errors.validation(errors);
  }

  private async require(tx: Tx, importId: string) {
    const imp = await tx.contactImport.findUnique({ where: { id: importId } });
    if (!imp) throw Errors.notFound('Import');
    return imp;
  }

  private view(r: ImportRow): ImportView {
    return {
      id: r.id,
      status: r.status as ImportView['status'],
      fileName: r.fileName,
      fileSize: r.fileSize,
      headers: r.headers as string[],
      mapping: r.mapping as Record<string, string>,
      options: r.options as ImportView['options'],
      totalRows: r.totalRows,
      processedRows: r.processedRows,
      counts: { created: r.createdCount, updated: r.updatedCount, skipped: r.skippedCount, errors: r.errorCount },
      dryRun: (r.dryRunSummary as ImportSummaryCounts | null) ?? null,
      failureReason: r.failureReason,
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      version: r.version,
    };
  }
}
