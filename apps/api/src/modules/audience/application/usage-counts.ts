import { Injectable } from '@nestjs/common';
import type { AudienceUsage } from '@workeasy/audience-core';
import type { Tx } from '@workeasy/db';

/** Import statuses whose CSV is still stored (imports.service / import-processor remove it on completion and cancellation). */
const FILE_HELD = ['uploaded', 'validated', 'processing', 'failed'] as const;

/** Audience's implementation of the AudienceUsage port (Phase 7.13): counts in the caller's tenant transaction. */
@Injectable()
export class AudienceUsageCounts implements AudienceUsage<Tx> {
  async activeContacts(scope: { tx: Tx; orgId: string; workspaceId: string }): Promise<number> {
    return scope.tx.contact.count({ where: { workspaceId: scope.workspaceId, deletedAt: null, erasedAt: null } });
  }

  async storedImportBytes(scope: { tx: Tx; orgId: string; workspaceId: string }): Promise<number> {
    // Only imports that still HOLD their file: completion and cancellation delete it (it holds personal data).
    const r = await scope.tx.contactImport.aggregate({ where: { workspaceId: scope.workspaceId, status: { in: [...FILE_HELD] } }, _sum: { fileSize: true } });
    return r._sum.fileSize ?? 0;
  }
}
