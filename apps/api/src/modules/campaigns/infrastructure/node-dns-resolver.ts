import { Resolver } from 'node:dns/promises';
import type { DnsResolver } from '../domain/deliverability.js';

/**
 * Production DNS lookups for sending-domain verification (Phase 7.8b). Bounded: 3 s per try, 2 tries. "No such record"
 * (ENOTFOUND / ENODATA) is null; anything else (timeout, SERVFAIL, refused) throws and becomes an `error` check, which
 * never downgrades a verified domain.
 */
export class NodeDnsResolver implements DnsResolver {
  private readonly resolver = new Resolver({ timeout: 3_000, tries: 2 });

  async txt(name: string): Promise<string[] | null> {
    try {
      return (await this.resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
    } catch (err) {
      if (isNoRecord(err)) return null;
      throw err;
    }
  }

  async cname(name: string): Promise<string | null> {
    try {
      return (await this.resolver.resolveCname(name))[0] ?? null;
    } catch (err) {
      if (isNoRecord(err)) return null;
      throw err;
    }
  }
}

const isNoRecord = (err: unknown) => ['ENOTFOUND', 'ENODATA', 'ENONAME'].includes((err as { code?: string }).code ?? '');

export const DNS_RESOLVER = Symbol('DNS_RESOLVER');
