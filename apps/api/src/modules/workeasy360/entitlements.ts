import { createHash } from 'node:crypto';
import { Workeasy360Error, type EntitlementAnswer } from './client.js';

/** An `allow` is trusted for the provider's `revalidate_after`, never longer than this... */
export const MAX_TRUST_SECONDS = 900;
/** ...and never shorter than this, whatever the provider advertises. */
export const MIN_TRUST_SECONDS = 30;
/** A denial is asked again this soon, so a renewal takes effect quickly. */
export const DENIAL_RECHECK_SECONDS = 60;
/** After a failed check, how long before the provider is asked again (the last answer stands meanwhile). */
export const FAILURE_BACKOFF_SECONDS = 60;
/** How long a last `allow` is kept to stand in for the provider during an outage (a denial: forever). */
export const LAST_KNOWN_KEEP_SECONDS = 7 * 24 * 3600;
/** After the provider refuses this product's own client, every question fails closed this long. */
export const CLIENT_REFUSAL_SECONDS = 60;
/** A 429 this soon after a refusal is the refusal talking (the provider limits failed client authentication), not an outage. */
export const RATE_LIMIT_AFTER_REFUSAL_SECONDS = 300;
/** Bound on this process's own copy of the last answers. */
const LOCAL_MAX_ENTRIES = 10_000;
const CLIENT_REFUSED_KEY = 'w360:client-refused';

/** Structured log sink (the API passes a Nest logger adapter; facts only, never tokens). */
export interface EntitlementLogger {
  info(facts: Record<string, unknown>, message: string): void;
  warn(facts: Record<string, unknown>, message: string): void;
  error(facts: Record<string, unknown>, message: string): void;
}

export interface EntitlementAccess {
  /** Reads are allowed. */
  allowed: boolean;
  /** Writes are allowed too (a suspended subscription is read-only). */
  writeAllowed: boolean;
  /** The provider's reason; `refused` when it refused this client; `unchecked` when no answer was ever available. */
  reason: string;
  status: 'allow' | 'deny' | 'refused' | 'unchecked';
}

/** No answer yet and the provider could not be asked: an outage never denies. */
export const UNCHECKED: EntitlementAccess = { allowed: true, writeAllowed: true, reason: 'unchecked', status: 'unchecked' };
const CLIENT_REFUSED: EntitlementAccess = { allowed: false, writeAllowed: false, reason: 'refused', status: 'refused' };

/** Where the last answers are shared between API instances (PostgreSQL: app.workeasy360_answer_get/put). */
export interface AnswerStore {
  get(key: string): Promise<string | null>;
  /** `ttlSeconds` null: kept without expiry. */
  set(key: string, value: string, ttlSeconds: number | null): Promise<void>;
}

export interface EntitlementSource {
  verifyEntitlement(organizationId: string, options?: { subject?: string | undefined; write?: boolean }): Promise<EntitlementAnswer>;
}

interface Recorded {
  d: 'allow' | 'deny';
  r: string;
  w: boolean;
  /** Epoch milliseconds when the provider answered. */
  at: number;
  /** Seconds this answer is trusted. */
  fresh: number;
}

export interface CheckOptions {
  /** The `sub` the person signed in with; omitted for a session that has none (a password session in a linked tenant). */
  subject?: string | undefined;
  /** Ask the provider now (sign-in), unless the client is refused or the provider failed a moment ago. */
  fresh?: boolean;
}

/**
 * Is this WorkEasy360 organization (and person) still entitled to the product?
 * Asked of the platform on its advertised cadence, never per request
 * (integration guide §7; entitlement API §9):
 *
 * - an `allow` is trusted for min(revalidate_after, 900) s, at least 30 s;
 * - a denial is asked again after 60 s; until then, and through any outage,
 *   it stands - it is kept without expiry in the shared store and in this
 *   process's copy, so neither a restart nor an outage hands access back;
 * - an outage (5xx, 429, timeout, network, unusable discovery) is never a
 *   denial: the last answer stands; with none, access continues; the provider
 *   is asked again after 60 s;
 * - a refusal of this product's own client (400/401/403: a revoked credential,
 *   a suspended integration) fails closed for the whole client - every
 *   question, for 60 s - and then one question is asked again; a 429 within
 *   five minutes of a refusal counts as one;
 * - within a process one request asks while the others use the last answer
 *   (or wait for the first one when there is none).
 */
export class EntitlementCache {
  private readonly local = new Map<string, Recorded>();
  private readonly backoff = new Map<string, number>();
  private readonly flights = new Map<string, Promise<EntitlementAccess>>();
  private refusedAt = 0;
  /** A refusal was seen and no question has been answered since: an outage must not hand older answers back. */
  private recovering = false;

  constructor(
    private readonly source: EntitlementSource,
    private readonly store: AnswerStore,
    private readonly logger?: EntitlementLogger,
    private readonly now: () => number = Date.now,
  ) {}

  async check(organizationId: string, options: CheckOptions = {}): Promise<EntitlementAccess> {
    const key = cacheKey(organizationId, options.subject);
    const now = this.now();
    if (await this.clientRefused(now)) return CLIENT_REFUSED;
    const known = await this.lastKnown(key);
    if (!options.fresh && known && now - known.at < known.fresh * 1000 && known.at >= this.refusedAt) return toAccess(known);
    if ((this.backoff.get(key) ?? 0) > now) return this.standIn(known);
    const flight = this.flights.get(key);
    if (flight) return known && !options.fresh ? toAccess(known) : flight;
    const started = this.ask(organizationId, options.subject, key, known, now).finally(() => this.flights.delete(key));
    this.flights.set(key, started);
    return started;
  }

  private async ask(organizationId: string, subject: string | undefined, key: string, known: Recorded | undefined, now: number): Promise<EntitlementAccess> {
    try {
      const answer = await this.source.verifyEntitlement(organizationId, { subject, write: false });
      const record: Recorded = {
        d: answer.decision,
        r: answer.reason.slice(0, 64),
        w: answer.decision === 'allow' && answer.writeAllowed,
        at: now,
        fresh: answer.decision === 'allow' ? Math.max(MIN_TRUST_SECONDS, Math.min(Math.floor(answer.revalidateAfter), MAX_TRUST_SECONDS)) : DENIAL_RECHECK_SECONDS,
      };
      await this.remember(key, record);
      this.recovering = false;
      if (!known || known.d !== record.d || known.r !== record.r) {
        this.logger?.info({ organizationId, decision: record.d, reason: record.r, person: Boolean(subject) }, 'workeasy360 entitlement changed');
      }
      return toAccess(record);
    } catch (err) {
      const rateLimitedByRefusal =
        err instanceof Workeasy360Error && err.code === 'rate_limited' && now - (await this.lastRefusal()) < RATE_LIMIT_AFTER_REFUSAL_SECONDS * 1000;
      if ((err instanceof Workeasy360Error && err.code === 'provider_refused') || rateLimitedByRefusal) {
        this.logger?.error({ organizationId, detail: err instanceof Workeasy360Error ? err.detail : '' }, "workeasy360 refused this product's client");
        await this.markClientRefused(now);
        return CLIENT_REFUSED;
      }
      this.logger?.warn(
        { organizationId, code: err instanceof Workeasy360Error ? err.code : err instanceof Error ? err.name : 'unknown', lastKnown: known?.d ?? null },
        'workeasy360 entitlement unavailable',
      );
      this.backoff.set(key, now + FAILURE_BACKOFF_SECONDS * 1000);
      return this.standIn(known);
    }
  }

  /** What stands in for the provider while it cannot be asked: the last answer, or (none yet) access - unless the client was refused. */
  private standIn(known: Recorded | undefined): EntitlementAccess {
    if (this.recovering) return CLIENT_REFUSED;
    return known ? toAccess(known) : UNCHECKED;
  }

  private async clientRefused(now: number): Promise<boolean> {
    const at = await this.lastRefusal();
    if (at > this.refusedAt) {
      // Another instance learned of a refusal: so does this one.
      this.refusedAt = at;
      this.recovering = true;
    }
    return this.refusedAt > 0 && now - this.refusedAt < CLIENT_REFUSAL_SECONDS * 1000;
  }

  /** When the client was last refused, by this process or (through the store) another one. */
  private async lastRefusal(): Promise<number> {
    let at = this.refusedAt;
    try {
      const raw = await this.store.get(CLIENT_REFUSED_KEY);
      const stored = raw ? Number((JSON.parse(raw) as { at?: unknown }).at) : 0;
      if (Number.isFinite(stored) && stored > at) at = stored;
    } catch {
      // This process's copy decides.
    }
    return at > 0 ? at : -Infinity;
  }

  private async markClientRefused(now: number): Promise<void> {
    this.refusedAt = now;
    this.recovering = true;
    try {
      await this.store.set(CLIENT_REFUSED_KEY, JSON.stringify({ at: now }), RATE_LIMIT_AFTER_REFUSAL_SECONDS);
    } catch {
      // This process's copy stands in.
    }
  }

  private async lastKnown(key: string): Promise<Recorded | undefined> {
    let shared: Recorded | undefined;
    try {
      const raw = await this.store.get(key);
      if (raw) shared = JSON.parse(raw) as Recorded;
    } catch {
      shared = undefined;
    }
    const local = this.local.get(key);
    if (shared && local) return local.at > shared.at ? local : shared;
    return shared ?? local;
  }

  private async remember(key: string, record: Recorded): Promise<void> {
    try {
      await this.store.set(key, JSON.stringify(record), record.d === 'allow' ? LAST_KNOWN_KEEP_SECONDS : null);
    } catch {
      // This process's copy stands in.
    }
    this.local.delete(key);
    this.local.set(key, record);
    while (this.local.size > LOCAL_MAX_ENTRIES) {
      const oldest = this.local.keys().next().value;
      if (oldest === undefined) break;
      this.local.delete(oldest);
    }
    this.backoff.delete(key);
  }
}

function cacheKey(organizationId: string, subject?: string): string {
  if (!subject) return `w360:org:${organizationId.toLowerCase()}`;
  return `w360:sub:${organizationId.toLowerCase()}:${createHash('sha256').update(subject).digest('hex').slice(0, 32)}`;
}

function toAccess(record: Recorded): EntitlementAccess {
  if (record.d === 'allow') return { allowed: true, writeAllowed: record.w, reason: record.r, status: 'allow' };
  return { allowed: false, writeAllowed: false, reason: record.r, status: 'deny' };
}
