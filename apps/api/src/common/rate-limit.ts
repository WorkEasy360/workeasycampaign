import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import { RATE_LIMIT_POLICY, type RateLimitPolicy } from './access.js';
import type { AppConfig } from '../config/env.js';
import { APP_CONFIG } from '../infrastructure/providers.js';
import { Errors } from './errors.js';

/** Fixed-window counter store. */
export interface RateLimitStore {
  /** Increments the bucket and returns its count within the current window and seconds until it resets. */
  hit(key: string, windowSeconds: number): Promise<{ count: number; resetInSeconds: number }>;
  /** Reachability check for readiness and metrics (shared stores only). */
  ping?(): Promise<void>;
  close(): Promise<void>;
}

export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');

/** Single-process store. Allowed outside production only (config requires REDIS_URL in production). */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  async hit(key: string, windowSeconds: number) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowSeconds * 1000 };
      this.buckets.set(key, b);
    }
    b.count += 1;
    if (this.buckets.size > 50_000) this.sweep(now);
    return { count: b.count, resetInSeconds: Math.ceil((b.resetAt - now) / 1000) };
  }

  private sweep(now: number) {
    for (const [k, v] of this.buckets) if (v.resetAt <= now) this.buckets.delete(k);
  }

  async close() {
    this.buckets.clear();
  }
}

/** Shared across API instances. */
export class RedisRateLimitStore implements RateLimitStore {
  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: false, lazyConnect: false });
  }

  async hit(key: string, windowSeconds: number) {
    const k = `rl:${key}`;
    const res = await this.redis.multi().incr(k).expire(k, windowSeconds, 'NX').ttl(k).exec();
    const count = Number(res?.[0]?.[1] ?? 1);
    const ttl = Number(res?.[2]?.[1] ?? windowSeconds);
    return { count, resetInSeconds: ttl > 0 ? ttl : windowSeconds };
  }

  async ping() {
    await this.redis.ping();
  }

  async close() {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

/** Applies @RateLimit policies. Keys use the trusted client IP (TRUST_PROXY) or the authenticated user id. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<RateLimitPolicy | undefined>(RATE_LIMIT_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!policy) return true;
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const subject = policy.by === 'user' ? (req.principal?.userId ?? `ip:${req.ip}`) : `ip:${req.ip}`;
    // Fail CLOSED (a limit that cannot be counted is not skipped: login and other brute-force protections depend on
    // it), but say so: 503 + Retry-After, not an internal error. Readiness reports the store too (load balancers).
    let hit: { count: number; resetInSeconds: number };
    try {
      hit = await this.store.hit(`${policy.name}:${subject}`, policy.windowSeconds);
    } catch {
      throw Errors.serviceUnavailable('Temporarily unavailable. Try again in a moment.');
    }
    const { count, resetInSeconds } = hit;
    // A per-deployment override (RATE_LIMIT_OVERRIDES) replaces the code default for that policy only.
    const limit = this.config.rateLimitOverrides[policy.name] ?? policy.limit;
    if (count > limit) throw Errors.rateLimited(resetInSeconds);
    return true;
  }
}
