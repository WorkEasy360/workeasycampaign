import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Database, Tx } from '@workeasy/db';
import type { ImportOptions, ImportSummaryCounts } from '@workeasy/shared';
import { AppError } from '../../../common/errors.js';
import type { TenantRequestContext } from '../../../common/request-context.js';
import type { AppConfig } from '../../../config/env.js';
import { FILE_STORE, type FileStore } from '../../../infrastructure/files/file-store.js';
import { APP_CONFIG, DATABASE } from '../../../infrastructure/providers.js';
import { inTenant, type TenantUnitOfWork } from '../../tenancy/application/tenant-tx.js';
import { cleanText, normalizeIdentity } from '../domain/normalization.js';
import { decideRow, type IdentityMatch, type ImportMode, type RowDecision } from '../domain/import-decision.js';
import { applyCustomFields, loadFieldDefinitions, lockFieldKeys, refreshSearchText } from './audience-support.js';
import { recordChannelConsent, recordTopicPreference } from './consent.service.js';
import { addToList, tagContacts } from './lists-tags.service.js';
import { CSV_LIMITS, readRows } from '../infrastructure/csv.js';

export const IMPORT_CHUNK = 250;
export const MAX_ISSUES_PER_PHASE = 5000;
export const importStorageKey = (workspaceId: string, importId: string) => `imports/${workspaceId}/${importId}.csv`;

/** Job envelope (same shape as worker tenant jobs) — everything needed to run or resume without the request. */
export interface ImportJob {
  tenant: { orgId: string; workspaceId: string };
  actor: { userId: string; email: string; displayName: string };
  correlationId: string;
  payload: { importId: string };
}

export function jobContext(job: ImportJob): TenantRequestContext {
  return {
    principal: { userId: job.actor.userId, email: job.actor.email, displayName: job.actor.displayName, emailVerified: true, sessionId: 'job', provider: 'job', authMethods: [] },
    access: { orgId: job.tenant.orgId, workspaceId: job.tenant.workspaceId, orgRoleKey: null, permissions: new Set(), workspaceAccess: null },
    meta: { requestId: job.correlationId, ipAddress: null, userAgent: null },
  };
}

type Issue = { rowNumber: number; column: string | null; code: string; message: string; severity: 'error' | 'warning' };

interface ParsedRow {
  rowNumber: number;
  identities: { kind: 'email' | 'phone' | 'whatsapp'; value: string; normalized: string }[];
  profile: Partial<Record<'firstName' | 'lastName' | 'company' | 'timezone' | 'locale', string | null>>;
  custom: Record<string, string>;
  issues: Issue[];
}

const PROFILE_TARGETS: Record<string, keyof ParsedRow['profile']> = {
  first_name: 'firstName',
  last_name: 'lastName',
  company: 'company',
  timezone: 'timezone',
  locale: 'locale',
};
const PROFILE_MAX = { firstName: 100, lastName: 100, company: 200, timezone: 64, locale: 35 } as const;

/**
 * Turns CSV rows into contacts. The same code runs the dry run (no writes except issues) and the real run, so a dry
 * run predicts exactly what the import will do. Deterministic: decisions depend only on the file, the mapping and
 * the database state (docs/imports.md).
 */
@Injectable()
export class ImportProcessor {
  private readonly logger = new Logger('ImportProcessor');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(FILE_STORE) private readonly files: FileStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Dry run: returns predicted counts and stores dry-run issues. */
  async dryRun(ctx: TenantRequestContext, importId: string): Promise<ImportSummaryCounts> {
    const imp = await this.load(ctx, importId);
    const counts: ImportSummaryCounts = { total: 0, create: 0, update: 0, skip: 0, error: 0 };
    await inTenant(this.db, ctx, ({ tx }) => tx.contactImportIssue.deleteMany({ where: { importId, phase: 'dry_run' } }));
    let issuesWritten = 0;
    const seen = new Set<string>();
    for await (const chunk of this.chunks(imp.workspaceId, importId, imp.delimiter)) {
      await inTenant(this.db, ctx, async ({ tx }) => {
        const { decisions, issues } = await this.decide(tx, chunk, imp.mapping, imp.options, seen);
        for (const d of decisions.values()) {
          counts.total++;
          if (d.action === 'error') counts.error++;
          else if (d.action === 'skip') counts.skip++;
          else counts[d.action]++;
        }
        issuesWritten += await this.writeIssues(tx, ctx, importId, 'dry_run', issues, MAX_ISSUES_PER_PHASE - issuesWritten);
      });
    }
    return counts;
  }

  /** Real run (job handler). Resumes after `processed_rows`; each chunk commits atomically with its checkpoint. */
  async run(job: ImportJob): Promise<void> {
    const ctx = jobContext(job);
    const importId = job.payload.importId;
    try {
      const imp = await this.load(ctx, importId);
      if (imp.status !== 'processing') return;
      const seen = new Set<string>();
      let issuesWritten = await inTenant(this.db, ctx, ({ tx }) => tx.contactImportIssue.count({ where: { importId, phase: 'run' } }));
      for await (const chunk of this.chunks(imp.workspaceId, importId, imp.delimiter)) {
        const last = chunk.at(-1)!.rowNumber;
        if (last <= imp.processedRows) {
          // Already committed before a restart: only rebuild the in-file duplicate set.
          for (const row of chunk) for (const i of this.parse(row, imp.mapping, imp.options).identities) seen.add(`${i.kind}:${i.normalized}`);
          continue;
        }
        const status = await inTenant(this.db, ctx, ({ tx }) => tx.contactImport.findUniqueOrThrow({ where: { id: importId }, select: { status: true } }));
        if (status.status !== 'processing') return; // cancelled
        issuesWritten += await inTenant(this.db, ctx, (uow) => this.applyChunk(uow, ctx, imp, chunk, seen, MAX_ISSUES_PER_PHASE - issuesWritten), {
          source: 'import',
        });
      }
      await inTenant(
        this.db,
        ctx,
        async ({ tx, event, audit }) => {
          const done = await tx.contactImport.update({ where: { id: importId }, data: { status: 'completed', completedAt: new Date(), updatedAt: new Date() } });
          const payload = { created: done.createdCount, updated: done.updatedCount, skipped: done.skippedCount, errors: done.errorCount, listIds: imp.options.listIds ?? [], tagIds: imp.options.tagIds ?? [] };
          await event('import.completed', importId, payload);
          await audit({ action: 'import.completed', targetType: 'import', targetId: importId, metadata: payload });
        },
        { source: 'import' },
      );
      // The file holds personal data; once the import is done it is no longer needed.
      await this.files.remove(importStorageKey(imp.workspaceId, importId));
    } catch (err) {
      const reason = err instanceof AppError ? err.message : 'Unexpected error while importing. Retry to continue from where it stopped.';
      this.logger.error(`import ${importId} failed: ${err instanceof Error ? err.stack : String(err)}`);
      await inTenant(this.db, ctx, async ({ tx, event, audit }) => {
        await tx.contactImport.update({ where: { id: importId }, data: { status: 'failed', failureReason: reason, updatedAt: new Date() } });
        await event('import.failed', importId, { reason });
        await audit({ action: 'import.failed', outcome: 'failure', targetType: 'import', targetId: importId, metadata: { reason } });
      }).catch((e: unknown) => this.logger.error(`could not mark import ${importId} failed: ${String(e)}`));
    }
  }

  // ─── internals ────────────────────────────────────────────────────────────────────────────────────────────

  private async load(ctx: TenantRequestContext, importId: string) {
    const imp = await inTenant(this.db, ctx, ({ tx }) => tx.contactImport.findUniqueOrThrow({ where: { id: importId } }));
    return { ...imp, mapping: imp.mapping as Record<string, string>, options: imp.options as ImportOptions };
  }

  private async *chunks(workspaceId: string, importId: string, delimiter: string) {
    let chunk: { rowNumber: number; cells: string[] }[] = [];
    for await (const row of readRows(this.files.open(importStorageKey(workspaceId, importId)), delimiter)) {
      chunk.push(row);
      if (chunk.length === IMPORT_CHUNK) {
        yield chunk;
        chunk = [];
      }
    }
    if (chunk.length) yield chunk;
  }

  parse(row: { rowNumber: number; cells: string[] }, mapping: Record<string, string>, options: ImportOptions): ParsedRow {
    const out: ParsedRow = { rowNumber: row.rowNumber, identities: [], profile: {}, custom: {}, issues: [] };
    for (const [col, target] of Object.entries(mapping)) {
      if (target === 'ignore') continue;
      const raw = row.cells[Number(col)];
      if (raw === undefined) continue;
      if (raw.length > CSV_LIMITS.maxCellChars) {
        out.issues.push({ rowNumber: row.rowNumber, column: target, code: 'CELL_TOO_LONG', message: `Value longer than ${CSV_LIMITS.maxCellChars} characters`, severity: 'error' });
        continue;
      }
      const value = cleanText(raw);
      if (target === 'email' || target === 'phone' || target === 'whatsapp') {
        if (!value) continue;
        const n = normalizeIdentity(target, value, options.defaultCountry);
        if (n.ok) out.identities.push({ kind: target, value: n.value, normalized: n.normalized });
        else out.issues.push({ rowNumber: row.rowNumber, column: target, code: n.code, message: n.message, severity: 'error' });
      } else if (target in PROFILE_TARGETS) {
        const key = PROFILE_TARGETS[target]!;
        if (value.length > PROFILE_MAX[key]) {
          out.issues.push({ rowNumber: row.rowNumber, column: target, code: 'VALUE_TOO_LONG', message: `Use at most ${PROFILE_MAX[key]} characters`, severity: 'error' });
        } else out.profile[key] = value || null;
      } else if (target.startsWith('cf:')) {
        out.custom[target.slice(3)] = value;
      }
    }
    return out;
  }

  private async decide(tx: Tx, chunk: { rowNumber: number; cells: string[] }[], mapping: Record<string, string>, options: ImportOptions, seen: Set<string>) {
    const parsed = chunk.map((r) => this.parse(r, mapping, options));
    const all = parsed.flatMap((p) => p.identities);
    const owners = all.length
      ? await tx.contactIdentity.findMany({
          where: { provider: '', OR: (['email', 'phone', 'whatsapp'] as const).map((kind) => ({ kind, valueNormalized: { in: all.filter((i) => i.kind === kind).map((i) => i.normalized) } })) },
          select: { kind: true, valueNormalized: true, contactId: true, contact: { select: { deletedAt: true, erasedAt: true } } },
        })
      : [];
    const ownerOf = new Map(owners.map((o) => [`${o.kind}:${o.valueNormalized}`, { contactId: o.contactId, deleted: !!(o.contact.deletedAt || o.contact.erasedAt) }]));
    const defs = await loadFieldDefinitions(tx);
    const decisions = new Map<number, RowDecision>();
    const issues: Issue[] = [];
    for (const p of parsed) {
      issues.push(...p.issues);
      const hasError = p.issues.some((i) => i.severity === 'error');
      const keys = p.identities.map((i) => `${i.kind}:${i.normalized}`);
      const seenBefore = keys.some((k) => seen.has(k));
      keys.forEach((k) => seen.add(k));
      let d: RowDecision;
      if (hasError) d = { action: 'error', code: 'NO_IDENTITY', message: 'Row has invalid values' };
      else {
        const matches: IdentityMatch[] = p.identities.map((i) => {
          const o = ownerOf.get(`${i.kind}:${i.normalized}`);
          return { kind: i.kind, contactId: o?.contactId ?? null, contactDeleted: o?.deleted ?? false };
        });
        d = decideRow((options.mode ?? 'create_or_update') as ImportMode, matches, seenBefore);
        // Custom-field values are validated here too, so the dry run predicts exactly what the real run will do.
        if (d.action === 'create' || d.action === 'update') {
          const patch = options.blankClears ? p.custom : Object.fromEntries(Object.entries(p.custom).filter(([, v]) => v !== ''));
          const cf = applyCustomFields(defs, {}, patch, { checkRequired: d.action === 'create', defaultCountry: options.defaultCountry });
          const fieldErrors = Object.entries(cf.errors);
          if (fieldErrors.length) {
            for (const [col, msgs] of fieldErrors) {
              issues.push({ rowNumber: p.rowNumber, column: col.replace('customFields.', 'cf:'), code: 'FIELD_INVALID', message: msgs.join('; '), severity: 'error' });
            }
            decisions.set(p.rowNumber, { action: 'error', code: 'NO_IDENTITY', message: 'Invalid field values' });
            continue;
          }
        }
      }
      if ((d.action === 'error' && !hasError) || d.action === 'skip') {
        issues.push({ rowNumber: p.rowNumber, column: null, code: d.code, message: d.message, severity: d.action === 'error' ? 'error' : 'warning' });
      }
      decisions.set(p.rowNumber, d);
    }
    return { parsed, decisions, issues };
  }

  /** Returns the number of issues written. */
  private async applyChunk(
    uow: TenantUnitOfWork,
    ctx: TenantRequestContext,
    imp: { id: string; orgId: string; workspaceId: string; mapping: Record<string, string>; options: ImportOptions; createdByUserId: string | null },
    chunk: { rowNumber: number; cells: string[] }[],
    seen: Set<string>,
    issueBudget: number,
  ): Promise<number> {
    const { tx } = uow;
    const { orgId, workspaceId, options } = imp;
    const { parsed, decisions, issues } = await this.decide(tx, chunk, imp.mapping, options, seen);
    const defs = await loadFieldDefinitions(tx);
    const userId = ctx.principal.userId;
    const counts = { created: 0, updated: 0, skipped: 0, errors: 0 };
    const touched: string[] = [];
    const usedKeys: string[] = [];

    for (const p of parsed) {
      const d = decisions.get(p.rowNumber)!;
      if (d.action === 'skip') {
        counts.skipped++;
        continue;
      }
      if (d.action === 'error') {
        counts.errors++;
        continue;
      }
      const existing = d.action === 'update' ? await tx.contact.findUniqueOrThrow({ where: { id: d.contactId } }) : null;
      const patch = options.blankClears ? p.custom : Object.fromEntries(Object.entries(p.custom).filter(([, v]) => v !== ''));
      const cf = applyCustomFields(defs, (existing?.customFields as Record<string, unknown>) ?? {}, patch, { checkRequired: d.action === 'create', defaultCountry: options.defaultCountry });
      if (Object.keys(cf.errors).length) {
        counts.errors++;
        for (const [col, msgs] of Object.entries(cf.errors)) {
          issues.push({ rowNumber: p.rowNumber, column: col.replace('customFields.', 'cf:'), code: 'FIELD_INVALID', message: msgs.join('; '), severity: 'error' });
        }
        continue;
      }
      usedKeys.push(...cf.usedKeys);
      const profile = Object.fromEntries(Object.entries(p.profile).filter(([, v]) => options.blankClears || (v !== null && v !== '')));

      let contactId: string;
      if (d.action === 'create') {
        const c = await tx.contact.create({
          data: { orgId, workspaceId, ...profile, subscriptionType: options.subscriptionType ?? 'marketing', source: 'import', sourceRef: imp.id, customFields: cf.values as object, createdByUserId: userId },
        });
        contactId = c.id;
        counts.created++;
        await uow.event('contact.created', contactId, { source: 'import', importId: imp.id });
      } else {
        contactId = d.contactId;
        const changes = [...Object.keys(profile), ...cf.usedKeys.map((k) => `customFields.${k}`)];
        if (changes.length) {
          // Subscription type is never changed by an update import: a self-unsubscribed contact stays unsubscribed.
          await tx.contact.update({ where: { id: contactId }, data: { ...profile, customFields: cf.values as object, updatedAt: new Date(), version: { increment: 1 } } });
          await uow.event('contact.updated', contactId, { changes, importId: imp.id });
        }
        counts.updated++;
      }
      // Attach identities the contact does not have yet (decideRow guarantees they are free or already its own).
      for (const i of p.identities) {
        const mine = await tx.contactIdentity.findFirst({ where: { contactId, kind: i.kind, valueNormalized: i.normalized }, select: { id: true } });
        if (mine) continue;
        const primary = (await tx.contactIdentity.count({ where: { contactId, kind: i.kind } })) === 0;
        const row = await tx.contactIdentity.create({ data: { orgId, workspaceId, contactId, kind: i.kind, value: i.value, valueNormalized: i.normalized, isPrimary: primary } });
        await uow.event('contact.identity_added', contactId, { identityId: row.id, kind: i.kind });
      }
      await refreshSearchText(tx, contactId);
      touched.push(contactId);

      for (const topicId of options.topicIds ?? []) {
        await this.softly(issues, p.rowNumber, 'topic', () =>
          recordTopicPreference(uow, orgId, workspaceId, contactId, topicId, 'subscribed', {
            source: 'import',
            actor: { type: 'user', id: userId },
            evidence: { importId: imp.id, row: p.rowNumber },
          }),
        );
      }
      if (options.consent) {
        await this.softly(issues, p.rowNumber, 'consent', () =>
          recordChannelConsent(uow, this.config.fingerprintSecret, orgId, workspaceId, contactId, {
            channel: options.consent!.channel,
            action: 'subscribed',
            lawfulBasis: options.consent!.lawfulBasis,
            source: 'import',
            actor: { type: 'user', id: userId },
            evidence: { importId: imp.id, row: p.rowNumber, note: options.consent!.evidenceNote },
          }),
        );
      }
    }

    for (const listId of options.listIds ?? []) await addToList(uow, orgId, workspaceId, listId, touched, 'import', userId);
    for (const tagId of options.tagIds ?? []) await tagContacts(uow, orgId, workspaceId, tagId, touched, userId);
    await lockFieldKeys(tx, defs, usedKeys);

    const written = await this.writeIssues(tx, ctx, imp.id, 'run', issues, issueBudget);
    await tx.contactImport.update({
      where: { id: imp.id },
      data: {
        processedRows: chunk.at(-1)!.rowNumber,
        createdCount: { increment: counts.created },
        updatedCount: { increment: counts.updated },
        skippedCount: { increment: counts.skipped },
        errorCount: { increment: counts.errors },
        updatedAt: new Date(),
      },
    });
    return written;
  }

  /** Consent/topic refusals (e.g. self-unsubscribed) become row warnings instead of failing the import. */
  private async softly(issues: Issue[], rowNumber: number, column: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (err) {
      if (!(err instanceof AppError) || err.status >= 500) throw err;
      const code = Object.values(err.fields ?? {})[0]?.[0] ?? err.code;
      issues.push({ rowNumber, column, code, message: err.message, severity: 'warning' });
    }
  }

  private async writeIssues(tx: Tx, ctx: TenantRequestContext, importId: string, phase: 'dry_run' | 'run', issues: Issue[], budget: number): Promise<number> {
    const take = issues.slice(0, Math.max(0, budget));
    if (take.length) {
      await tx.contactImportIssue.createMany({
        data: take.map((i) => ({ orgId: ctx.access.orgId, workspaceId: ctx.access.workspaceId!, importId, phase, ...i, message: i.message.slice(0, 500) })),
      });
    }
    return take.length;
  }
}
