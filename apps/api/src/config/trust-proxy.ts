import { isIP } from 'node:net';

/**
 * TRUST_PROXY decides which hops may set X-Forwarded-For, i.e. whose claim about the client IP we believe.
 * Client IPs feed rate limiting, login throttling and audit logs, so trusting everyone (`true`) would let any
 * client choose its own IP. Accepted values:
 *   false                     – no proxy; the socket address is the client (default when nothing is in front)
 *   <list>                    – comma-separated IPs/CIDRs and/or the keywords loopback, linklocal, uniquelocal
 * `true` is rejected outright. A HOP COUNT is rejected too (Gate D, 2026-10-09): it cannot check that the immediate
 * peer IS a proxy, so a client connecting directly could forge X-Forwarded-For (advisory GHSA for fastify < 5.12.1;
 * fastify 5.12 dropped hop counts for that reason). Name the proxies by address instead.
 */
export type TrustProxySetting = false | string[];

const KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

export function parseTrustProxy(raw: string): TrustProxySetting {
  const value = raw.trim();
  if (value === '' || value === 'false') return false;
  if (value === 'true') {
    throw new Error('TRUST_PROXY=true would trust X-Forwarded-For from anyone; set the proxy addresses or CIDRs');
  }
  if (/^\d+$/.test(value)) {
    throw new Error('TRUST_PROXY hop counts are not accepted (a direct client could forge X-Forwarded-For): list the proxy addresses or CIDRs, e.g. 10.0.0.0/8');
  }
  const entries = value.split(',').map((s) => s.trim()).filter(Boolean);
  for (const entry of entries) {
    if (KEYWORDS.has(entry)) continue;
    const [addr, bits, extra] = entry.split('/');
    const family = isIP(addr ?? '');
    const bitsOk =
      bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= (family === 6 ? 128 : 32) && Number(bits) >= 8);
    if (!family || !bitsOk || extra !== undefined) throw new Error(`TRUST_PROXY entry is not an IP, CIDR or keyword: ${entry}`);
  }
  return entries;
}
