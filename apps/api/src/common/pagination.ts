import { Errors } from './errors.js';

/** Opaque keyset cursor over (timestamp, id). Clients must treat it as an opaque string. */
export interface Cursor {
  t: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof v.t === 'string' && typeof v.id === 'string' && !Number.isNaN(Date.parse(v.t))) {
      return { t: v.t, id: v.id };
    }
  } catch {
    // fall through
  }
  throw Errors.validation({ cursor: ['Invalid cursor'] });
}

/** Given limit+1 rows, returns the page and the cursor for the next one. */
export function pageOf<T>(rows: T[], limit: number, key: (row: T) => Cursor): { data: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1);
  return { data, nextCursor: hasMore && last ? encodeCursor(key(last)) : null };
}
