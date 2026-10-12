/**
 * Sending-domain verification (Phase 7.8b; campaign amendment §S). Pure: DNS answers in, check results out. A domain is
 * verified only when EVERY check passes on real DNS answers — never claimed:
 *  - ownership: TXT at `_workeasy.<domain>` contains `workeasy-verification=<token>`;
 *  - SPF:       exactly one `v=spf1` TXT record at the domain, containing the provider's mechanism (configured);
 *  - DKIM:      a TXT key (`v=DKIM1`/`p=`) or a provider CNAME at `<selector>._domainkey.<domain>` (selector configured);
 *  - DMARC:     exactly one `v=DMARC1` TXT record at `_dmarc.<domain>` (required by the major mailbox providers for bulk
 *               senders since 2024).
 * A DNS failure (timeout, SERVFAIL) is `error`: it never turns a verified domain into a failed one.
 */
export type CheckResult = 'pass' | 'fail' | 'missing' | 'error' | 'not_checked';
export interface DomainChecks {
  ownership: CheckResult;
  spf: CheckResult;
  dkim: CheckResult;
  dmarc: CheckResult;
}

/** DNS lookups; `null` = the name has no such record (NXDOMAIN / NODATA); throws on resolver failure. */
export interface DnsResolver {
  txt(name: string): Promise<string[] | null>;
  cname(name: string): Promise<string | null>;
}

export interface ProviderDnsRequirements {
  /** SPF mechanism the provider needs, e.g. "include:mailgun.org"; null → SPF cannot be confirmed (not_checked). */
  spfInclude: string | null;
  /** DKIM selector the provider signs with, e.g. "mx"; null → DKIM cannot be confirmed (not_checked). */
  dkimSelector: string | null;
}

export const DOMAIN_PATTERN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** Names that are never a customer's public sending domain. */
const RESERVED = /(^|\.)(localhost|local|internal|invalid|test|example|home\.arpa|in-addr\.arpa|ip6\.arpa|onion)$/;

export function normalizeDomain(input: string): string | null {
  const d = input.trim().toLowerCase().replace(/\.$/, '');
  if (d.length > 253 || !DOMAIN_PATTERN.test(d) || RESERVED.test(d)) return null;
  return d;
}

export const ownershipHost = (domain: string) => `_workeasy.${domain}`;
export const ownershipValue = (token: string) => `workeasy-verification=${token}`;

async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false };
  }
}

export async function checkDomain(domain: string, token: string, req: ProviderDnsRequirements, dns: DnsResolver): Promise<DomainChecks> {
  const [own, apex, dmarc, dkimTxt, dkimCname] = await Promise.all([
    attempt(() => dns.txt(ownershipHost(domain))),
    attempt(() => dns.txt(domain)),
    attempt(() => dns.txt(`_dmarc.${domain}`)),
    req.dkimSelector ? attempt(() => dns.txt(`${req.dkimSelector}._domainkey.${domain}`)) : Promise.resolve(null),
    req.dkimSelector ? attempt(() => dns.cname(`${req.dkimSelector}._domainkey.${domain}`)) : Promise.resolve(null),
  ]);

  const ownership: CheckResult = !own.ok ? 'error' : !own.value?.length ? 'missing' : own.value.some((r) => r.trim() === ownershipValue(token)) ? 'pass' : 'fail';

  let spf: CheckResult;
  if (!apex.ok) spf = 'error';
  else {
    const records = (apex.value ?? []).filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
    if (!records.length) spf = 'missing';
    else if (records.length > 1) spf = 'fail'; // RFC 7208 permerror: more than one SPF record
    else if (!req.spfInclude) spf = 'not_checked';
    else spf = records[0]!.toLowerCase().split(/\s+/).includes(req.spfInclude.toLowerCase()) ? 'pass' : 'fail';
  }

  let dkim: CheckResult;
  if (!req.dkimSelector) dkim = 'not_checked';
  else if (!dkimTxt?.ok && !dkimCname?.ok) dkim = 'error';
  else {
    const key = dkimTxt?.ok ? (dkimTxt.value ?? []).some((r) => /(^|;)\s*(v=DKIM1|p=[A-Za-z0-9+/=]{20,})/i.test(r)) : false;
    const cname = dkimCname?.ok ? !!dkimCname.value : false;
    dkim = key || cname ? 'pass' : 'missing';
  }

  let dmarcResult: CheckResult;
  if (!dmarc.ok) dmarcResult = 'error';
  else {
    const records = (dmarc.value ?? []).filter((r) => /^v=DMARC1(\s*;|$)/i.test(r.trim()));
    dmarcResult = !records.length ? 'missing' : records.length > 1 ? 'fail' : 'pass';
  }
  return { ownership, spf, dkim, dmarc: dmarcResult };
}

/** Verified only when every check passes; any DNS error keeps the previous status (never a downgrade on an outage). */
export function nextDomainStatus(previous: 'pending' | 'verified' | 'failed', c: DomainChecks): 'pending' | 'verified' | 'failed' {
  const all = [c.ownership, c.spf, c.dkim, c.dmarc];
  if (all.every((x) => x === 'pass')) return 'verified';
  if (all.includes('error')) return previous;
  if (all.includes('not_checked')) return 'pending';
  return 'failed';
}

/** The DNS records the customer must create (guidance shown in the product). */
export function dnsGuidance(domain: string, token: string, req: ProviderDnsRequirements) {
  return [
    { purpose: 'ownership', type: 'TXT', host: ownershipHost(domain), value: ownershipValue(token) },
    { purpose: 'spf', type: 'TXT', host: domain, value: req.spfInclude ? `v=spf1 ${req.spfInclude} ~all` : 'v=spf1 (the mechanism of your email provider) ~all' },
    {
      purpose: 'dkim',
      type: 'TXT or CNAME',
      host: req.dkimSelector ? `${req.dkimSelector}._domainkey.${domain}` : `(selector)._domainkey.${domain}`,
      value: 'The DKIM record your email provider shows for this domain',
    },
    { purpose: 'dmarc', type: 'TXT', host: `_dmarc.${domain}`, value: `v=DMARC1; p=none; rua=mailto:dmarc-reports@${domain}` },
  ] as const;
}
