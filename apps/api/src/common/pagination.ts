import { createHmac, timingSafeEqual } from 'node:crypto';
import { Errors } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque keyset cursor over (timestamp, id). Clients must treat it as an opaque string. */
export interface Cursor {
  t: string;
  id: string;
}

/**
 * Cursors are SIGNED and SCOPED (6.13 hardening): `base64url(payload).base64url(HMAC-SHA256(key, payload|scope))`.
 * The scope — tenant ids, the list's name and its filters — is not in the token; it is recomputed from the request on
 * decode, so a cursor replayed in another workspace, on another list or with other filters fails verification (400),
 * and a forged or edited payload cannot verify at all. The key is derived from SESSION_SECRET at boot; without it,
 * encoding and decoding fail closed.
 */
let key: Buffer | null = null;

export function configureCursorKey(secret: string): void {
  key = createHmac('sha256', secret).update('workeasy.cursor.v1').digest();
}

/** A stable scope string: tenant + list name + filters (sorted keys; `cursor` and `limit` never part of it). */
export function cursorScope(
  tenant: { orgId?: string | null; workspaceId?: string | null; userId?: string | null },
  list: string,
  filters: Record<string, unknown> = {},
): string {
  const f = Object.fromEntries(
    Object.keys(filters)
      .filter((k) => k !== 'cursor' && k !== 'limit' && filters[k] !== undefined)
      .sort()
      .map((k) => [k, filters[k]]),
  );
  return JSON.stringify([tenant.orgId ?? null, tenant.workspaceId ?? null, tenant.userId ?? null, list, f]);
}

function sign(payload: string, scope: string): Buffer {
  if (!key) throw new Error('cursor key not configured');
  return createHmac('sha256', key).update(payload).update('|').update(scope).digest();
}

export function encodeCursor(c: Cursor, scope: string): string {
  const payload = Buffer.from(JSON.stringify(c)).toString('base64url');
  return `${payload}.${sign(payload, scope).toString('base64url')}`;
}

export function decodeCursor(raw: string | undefined, scope: string): Cursor | null {
  if (!raw) return null;
  const [payload, mac, extra] = raw.split('.');
  if (payload && mac && extra === undefined) {
    const given = Buffer.from(mac, 'base64url');
    const expected = sign(payload, scope);
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      try {
        const v = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<Cursor>;
        // Defence in depth behind the signature: every keyset id is a uuid and t a timestamp.
        if (typeof v.t === 'string' && typeof v.id === 'string' && !Number.isNaN(Date.parse(v.t)) && UUID.test(v.id)) return { t: v.t, id: v.id };
      } catch {
        // fall through
      }
    }
  }
  throw Errors.validation({ cursor: ['Invalid cursor'] });
}

/** Given limit+1 rows, returns the page and the (scoped, signed) cursor for the next one. */
export function pageOf<T>(rows: T[], limit: number, keyOf: (row: T) => Cursor, scope: string): { data: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1);
  return { data, nextCursor: hasMore && last ? encodeCursor(keyOf(last), scope) : null };
}
