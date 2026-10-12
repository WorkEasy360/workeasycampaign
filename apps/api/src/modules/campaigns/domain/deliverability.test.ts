import { describe, expect, it } from 'vitest';
import { checkDomain, type DnsResolver, nextDomainStatus, normalizeDomain } from './deliverability.js';

/** Sending-domain verification logic (Phase 7.8b) against a deterministic DNS double. */
const token = 'tok_0123456789abcdefghij';
const req = { spfInclude: 'include:mailgun.org', dkimSelector: 'mx' };
function dns(records: Record<string, readonly string[] | 'servfail'>, cnames: Record<string, string> = {}): DnsResolver {
  return {
    async txt(name) {
      const r = records[name];
      if (r === 'servfail') throw new Error('SERVFAIL');
      return r ? [...r] : null;
    },
    async cname(name) {
      return cnames[name] ?? null;
    },
  };
}
const good = {
  '_workeasy.acme.com': [`workeasy-verification=${token}`],
  'acme.com': ['v=spf1 include:mailgun.org ~all', 'google-site-verification=x'],
  'mx._domainkey.acme.com': ['k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ'],
  '_dmarc.acme.com': ['v=DMARC1; p=none'],
};

describe('sending-domain checks', () => {
  it('every record present and correct → all pass → verified', async () => {
    const c = await checkDomain('acme.com', token, req, dns(good));
    expect(c).toEqual({ ownership: 'pass', spf: 'pass', dkim: 'pass', dmarc: 'pass' });
    expect(nextDomainStatus('pending', c)).toBe('verified');
  });

  it('a provider-hosted DKIM CNAME passes', async () => {
    const { ['mx._domainkey.acme.com']: _drop, ...rest } = good;
    expect((await checkDomain('acme.com', token, req, dns(rest, { 'mx._domainkey.acme.com': 'mx.domainkey.mailgun.org' }))).dkim).toBe('pass');
  });

  it.each([
    ['wrong ownership token', { '_workeasy.acme.com': ['workeasy-verification=someone-elses'] }, 'ownership', 'fail'],
    ['no ownership record', { '_workeasy.acme.com': [] }, 'ownership', 'missing'],
    ['SPF without the provider', { 'acme.com': ['v=spf1 include:other.net ~all'] }, 'spf', 'fail'],
    ['two SPF records (permerror)', { 'acme.com': ['v=spf1 include:mailgun.org ~all', 'v=spf1 -all'] }, 'spf', 'fail'],
    ['no SPF record', { 'acme.com': ['something else'] }, 'spf', 'missing'],
    ['no DKIM key', { 'mx._domainkey.acme.com': ['v=spf1'] }, 'dkim', 'missing'],
    ['no DMARC', { '_dmarc.acme.com': [] }, 'dmarc', 'missing'],
    ['two DMARC records', { '_dmarc.acme.com': ['v=DMARC1; p=none', 'v=DMARC1; p=reject'] }, 'dmarc', 'fail'],
  ] as const)('%s', async (_name, override, check, expected) => {
    const c = await checkDomain('acme.com', token, req, dns({ ...good, ...override }));
    expect(c[check]).toBe(expected);
    expect(nextDomainStatus('pending', c)).toBe('failed');
  });

  it('a DNS outage is "error" and never downgrades a verified domain', async () => {
    const c = await checkDomain('acme.com', token, req, dns({ ...good, '_dmarc.acme.com': 'servfail' }));
    expect(c.dmarc).toBe('error');
    expect(nextDomainStatus('verified', c)).toBe('verified');
    expect(nextDomainStatus('pending', c)).toBe('pending');
  });

  it('without the provider requirements configured, SPF and DKIM cannot be confirmed: never verified', async () => {
    const c = await checkDomain('acme.com', token, { spfInclude: null, dkimSelector: null }, dns(good));
    expect([c.spf, c.dkim]).toEqual(['not_checked', 'not_checked']);
    expect(nextDomainStatus('pending', c)).toBe('pending');
  });

  it('domain input: normalized; IPs, single labels and reserved names refused', () => {
    expect(normalizeDomain(' Mail.Acme.COM. ')).toBe('mail.acme.com');
    for (const bad of ['localhost', 'acme', '10.0.0.1', 'a..b.com', 'x.local', 'svc.internal', 'acme.test', 'evil.com/path', `${'a'.repeat(64)}.com`, 'xn--.com']) expect(normalizeDomain(bad), bad).toBeNull();
  });
});
