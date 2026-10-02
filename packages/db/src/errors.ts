/**
 * Resolve the PostgreSQL SQLSTATE behind an error, whichever way Prisma or the driver adapter wrapped it.
 * Classification must use SQLSTATE, not Prisma codes: the same database error surfaces as P2002/P2003/P2039/P2010
 * depending on whether it came from a model call or raw SQL.
 */
interface ErrorLike {
  code?: unknown;
  message?: unknown;
  meta?: { code?: unknown; driverAdapterError?: { cause?: { kind?: unknown; originalCode?: unknown } } };
  cause?: unknown;
}

const PRISMA_TO_SQLSTATE: Record<string, string> = {
  P2002: '23505', // unique_violation
  P2003: '23503', // foreign_key_violation
  P2034: '40001', // serialization_failure / write conflict
};

export function sqlStateOf(err: unknown, depth = 0): string | undefined {
  const e = err as ErrorLike | null;
  if (!e || typeof e !== 'object' || depth > 5) return undefined;
  const adapter = e.meta?.driverAdapterError?.cause?.originalCode;
  if (typeof adapter === 'string' && /^[0-9A-Z]{5}$/.test(adapter)) return adapter;
  if (typeof e.meta?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.meta.code)) return e.meta.code;
  if (typeof e.message === 'string') {
    const m = /Code: `([0-9A-Z]{5})`/.exec(e.message);
    if (m) return m[1];
  }
  if (typeof e.code === 'string') {
    if (/^[0-9A-Z]{5}$/.test(e.code) && !e.code.startsWith('P')) return e.code; // node-postgres error
    if (PRISMA_TO_SQLSTATE[e.code]) return PRISMA_TO_SQLSTATE[e.code];
  }
  return e.cause ? sqlStateOf(e.cause, depth + 1) : undefined;
}

export const isUniqueViolation = (err: unknown): boolean => sqlStateOf(err) === '23505';
export const isForeignKeyViolation = (err: unknown): boolean => sqlStateOf(err) === '23503';
export const isPermissionDenied = (err: unknown): boolean => sqlStateOf(err) === '42501';
export const isSerializationFailure = (err: unknown): boolean => sqlStateOf(err) === '40001';
export const isNotFound = (err: unknown): boolean => (err as ErrorLike | null)?.code === 'P2025';
