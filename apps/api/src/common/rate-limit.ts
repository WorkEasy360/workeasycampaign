import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import { RATE_LIMIT_POLICY, type RateLimitPolicy } from './access.js';
import { Errors } from './errors.js';

/** Fixed-window counter store. */
export interface RateLimitStore {
  /** Increments the bucket and returns its count within the current window and seconds until it resets. */
  hit(key: string, windowSeconds: number): Promise<{ count: number; resetInSeconds: number }>;
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

  async close() {
    await this.redis.quit();
  }
}

/** Applies @RateLimit policies. Keys use the trusted client IP (TRUST_PROXY) or the authenticated user id. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<RateLimitPolicy | undefined>(RATE_LIMIT_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!policy) return true;
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const subject = policy.by === 'user' ? (req.principal?.userId ?? `ip:${req.ip}`) : `ip:${req.ip}`;
    const { count, resetInSeconds } = await this.store.hit(`${policy.name}:${subject}`, policy.windowSeconds);
    if (count > policy.limit) throw Errors.rateLimited(resetInSeconds);
    return true;
  }
}
