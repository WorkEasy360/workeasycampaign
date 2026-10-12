import type { TenantScope } from '@workeasy/audience-core';
import type { Tx } from '@workeasy/db';

/** A scope whose labels disagree with the transaction's tenant: a programming error, never a data condition. */
export class TenantScopeMismatchError extends Error {
  constructor() {
    super('The tenant scope does not match the transaction tenant context');
    this.name = 'TenantScopeMismatchError';
  }
}

const verified = new WeakMap<Tx, string>();

/**
 * Every adapter call starts here. The transaction must have been opened by `withTenant` for exactly the scope's org
 * and workspace (RLS then confines every query to that workspace); a mislabelled scope, an unscoped transaction or an
 * org-only transaction is refused before any Audience table is read. Verified once per transaction.
 */
export async function assertTenantScope(scope: TenantScope<Tx>): Promise<void> {
  const key = `${scope.orgId}\u0000${scope.workspaceId}`;
  if (verified.get(scope.tx) === key) return;
  const rows = await scope.tx.$queryRaw<{ org: string | null; ws: string | null }[]>`
    SELECT current_setting('app.org_id', true) AS org, current_setting('app.workspace_id', true) AS ws`;
  const row = rows[0];
  if (!scope.orgId || !scope.workspaceId || row?.org !== scope.orgId || row?.ws !== scope.workspaceId) throw new TenantScopeMismatchError();
  verified.set(scope.tx, key);
}

/**
 * The scope of a transaction that is known to belong to `workspaceId` — for callers that hold a tenant transaction and a
 * workspace id but no org id (the frozen `EligibilityService.evaluate(tx, workspaceId, …)` signature). The org comes
 * from the transaction's own tenant context (set by `withTenant` from an authorized context); a workspace mismatch is
 * refused exactly like assertTenantScope.
 */
export async function tenantScopeFor(tx: Tx, workspaceId: string): Promise<TenantScope<Tx>> {
  const rows = await tx.$queryRaw<{ org: string | null; ws: string | null }[]>`
    SELECT current_setting('app.org_id', true) AS org, current_setting('app.workspace_id', true) AS ws`;
  const row = rows[0];
  if (!row?.org || !workspaceId || row.ws !== workspaceId) throw new TenantScopeMismatchError();
  verified.set(tx, `${row.org}\u0000${workspaceId}`);
  return { tx, orgId: row.org, workspaceId };
}
