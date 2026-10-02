import { isIP } from 'node:net';

/**
 * TRUST_PROXY decides which hops may set X-Forwarded-For, i.e. whose claim about the client IP we believe.
 * Client IPs feed rate limiting, login throttling and audit logs, so trusting everyone (`true`) would let any
 * client choose its own IP. Accepted values:
 *   false                     – no proxy; the socket address is the client (default when nothing is in front)
 *   <n>                       – exactly n proxy hops in front of the API (e.g. 1 for a single load balancer)
 *   <list>                    – comma-separated IPs/CIDRs and/or the keywords loopback, linklocal, uniquelocal
 * `true` is rejected outright.
 */
export type TrustProxySetting = false | number | string[];

const KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

export function parseTrustProxy(raw: string): TrustProxySetting {
  const value = raw.trim();
  if (value === '' || value === 'false') return false;
  if (value === 'true') {
    throw new Error('TRUST_PROXY=true would trust X-Forwarded-For from anyone; set a hop count or proxy addresses');
  }
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    if (n < 1 || n > 10) throw new Error('TRUST_PROXY hop count must be between 1 and 10');
    return n;
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
