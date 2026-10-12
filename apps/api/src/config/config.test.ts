import { describe, expect, it } from 'vitest';
import { loadConfig } from './env.js';
import { parseTrustProxy } from './trust-proxy.js';

const base = { DATABASE_URL: 'postgresql://x', IDENTITY_DATABASE_URL: 'postgresql://y' };
const prod = {
  ...base,
  NODE_ENV: 'production',
  APP_URL: 'https://app.example.com',
  SESSION_SECRET: 'a'.repeat(48),
  DATA_FINGERPRINT_SECRET: 'b'.repeat(48),
  UNSUBSCRIBE_SECRET: 'u'.repeat(48),
  FILE_STORE_DIR: '/var/lib/workeasy/files',
  TRUST_PROXY: '10.0.0.0/8',
  REDIS_URL: 'redis://r',
  MAIL_TRANSPORT: 'smtp',
  MAIL_FROM: 'x@example.com',
};

describe('configuration fails closed', () => {
  it('treats a missing NODE_ENV as production and refuses to start without secrets', () => {
    expect(() => loadConfig({ ...base })).toThrow(/SESSION_SECRET is required in production/);
  });

  it.each(['APP_URL', 'SESSION_SECRET', 'DATA_FINGERPRINT_SECRET', 'FILE_STORE_DIR', 'TRUST_PROXY', 'REDIS_URL', 'MAIL_FROM'])(
    'production refuses to start without %s',
    (key) => {
      const env: Record<string, string> = { ...prod };
      delete env[key];
      expect(() => loadConfig(env)).toThrow(new RegExp(`${key} is required in production`));
    },
  );

  it('rejects the development secret, file mail and plain http in production', () => {
    expect(() => loadConfig({ ...prod, SESSION_SECRET: 'development-only-session-secret-do-not-use-in-production-0000' })).toThrow(
      /development secret/,
    );
    expect(() => loadConfig({ ...prod, MAIL_TRANSPORT: 'file' })).toThrow(/smtp/);
    expect(() => loadConfig({ ...prod, APP_URL: 'http://app.example.com' })).toThrow(/https/);
  });

  it('uses __Host- secure cookies in production and explicit dev defaults only in development', () => {
    expect(loadConfig(prod).cookies).toEqual({ secure: true, sessionName: '__Host-wk_session', csrfName: '__Host-wk_csrf' });
    const dev = loadConfig({ ...base, NODE_ENV: 'development' });
    expect(dev.cookies.secure).toBe(false);
    expect(dev.trustProxy).toEqual(['loopback']);
    expect(dev.mail.transport).toBe('file');
  });

  it('rejects short secrets in every environment', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'development', SESSION_SECRET: 'short' })).toThrow(/at least 32/);
  });
});

describe('blank values (a copy of .env.example)', () => {
  it('treats KEY= as unset: optional providers stay off, required secrets still fail in production', () => {
    const blanks = { SMS_PROVIDER: '', TWILIO_ACCOUNT_SID: '', WHATSAPP_PROVIDER: '', WHATSAPP_API_VERSION: '', DELIVERY_PROVIDER: '', MAILGUN_API_KEY: '', METRICS_TOKEN: ' ', JOB_QUEUE: '' };
    const c = loadConfig({ ...base, NODE_ENV: 'development', ...blanks });
    expect(c.smsProvider).toBeNull();
    expect(c.whatsappProvider).toBeNull();
    expect(() => loadConfig({ ...prod, SESSION_SECRET: '' })).toThrow(/SESSION_SECRET is required in production/);
    expect(() => loadConfig({ ...prod, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });
});

describe('TRUST_PROXY parsing', () => {
  it('never accepts "true"', () => {
    expect(() => parseTrustProxy('true')).toThrow(/trust X-Forwarded-For from anyone/);
  });
  it('accepts false, addresses, CIDRs and keywords', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('10.0.0.0/8, loopback,2001:db8::1')).toEqual(['10.0.0.0/8', 'loopback', '2001:db8::1']);
  });
  it('rejects hop counts: they cannot verify the peer, so a direct client could forge X-Forwarded-For', () => {
    for (const n of ['1', '2', '10']) expect(() => parseTrustProxy(n)).toThrow(/hop counts are not accepted/);
  });
  it('rejects garbage, zero hops and over-broad CIDRs', () => {
    expect(() => parseTrustProxy('0')).toThrow();
    expect(() => parseTrustProxy('everyone')).toThrow();
    expect(() => parseTrustProxy('0.0.0.0/0')).toThrow();
  });
});

describe('background jobs and process roles (Phase 7.6)', () => {
  it('production uses the durable queue by default and refuses the in-process one', () => {
    expect(loadConfig(prod).jobQueue).toBe('postgres');
    expect(() => loadConfig({ ...prod, JOB_QUEUE: 'inline' })).toThrow(/JOB_QUEUE must be "postgres" in production/);
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).jobQueue).toBe('inline');
    expect(loadConfig({ ...base, NODE_ENV: 'development', JOB_QUEUE: 'postgres' }).jobQueue).toBe('postgres');
    expect(() => loadConfig({ ...prod, JOB_QUEUE: 'redis' })).toThrow(/JOB_QUEUE/);
  });

  it('process roles: all by default; a worker is "jobs,scheduler"; unknown roles fail boot', () => {
    expect([...loadConfig(prod).processRoles].sort()).toEqual(['http', 'jobs', 'scheduler']);
    expect([...loadConfig({ ...prod, PROCESS_ROLES: 'jobs, scheduler' }).processRoles].sort()).toEqual(['jobs', 'scheduler']);
    expect(() => loadConfig({ ...prod, PROCESS_ROLES: 'jobs,cron' })).toThrow(/unknown role\(s\) cron/);
    expect(() => loadConfig({ ...prod, PROCESS_ROLES: ' , ' })).toThrow(/PROCESS_ROLES/);
  });

  it('bounds the job concurrency and the scheduler interval', () => {
    expect(() => loadConfig({ ...prod, JOB_CONCURRENCY: '0' })).toThrow(/JOB_CONCURRENCY/);
    expect(() => loadConfig({ ...prod, JOB_CONCURRENCY: '33' })).toThrow(/JOB_CONCURRENCY/);
    expect(() => loadConfig({ ...prod, CAMPAIGN_SCHEDULER_INTERVAL_SECONDS: '1' })).toThrow(/CAMPAIGN_SCHEDULER_INTERVAL_SECONDS/);
    expect(loadConfig({ ...prod, CAMPAIGN_SCHEDULER_INTERVAL_SECONDS: '30' }).campaignSchedulerIntervalMs).toBe(30_000);
  });
});

describe('delivery feedback and tracking (Phase 7.9/7.10)', () => {
  it('webhooks are off without a signing key; a short key fails boot', () => {
    expect(loadConfig(prod).deliveryWebhookSigningKey).toBeNull();
    expect(loadConfig({ ...prod, DELIVERY_WEBHOOK_SIGNING_KEY: 'k'.repeat(32) }).deliveryWebhookSigningKey).toBe('k'.repeat(32));
    expect(() => loadConfig({ ...prod, DELIVERY_WEBHOOK_SIGNING_KEY: 'short' })).toThrow(/DELIVERY_WEBHOOK_SIGNING_KEY/);
  });

  it('open/click tracking is off unless listed; unknown values fail boot', () => {
    expect(loadConfig(prod).deliveryTracking).toEqual({ opens: false, clicks: false });
    expect(loadConfig({ ...prod, DELIVERY_TRACKING: 'opens,clicks' }).deliveryTracking).toEqual({ opens: true, clicks: true });
    expect(loadConfig({ ...prod, DELIVERY_TRACKING: 'clicks' }).deliveryTracking).toEqual({ opens: false, clicks: true });
    expect(() => loadConfig({ ...prod, DELIVERY_TRACKING: 'pixels' })).toThrow(/DELIVERY_TRACKING/);
  });
});

describe('unsubscribe link keys (Gate G)', () => {
  it('production requires its own key; previous keys are kept for verification, current first', async () => {
    const { UNSUBSCRIBE_SECRET: _omit, ...withoutKey } = prod;
    expect(() => loadConfig(withoutKey)).toThrow(/UNSUBSCRIBE_SECRET is required in production/);
    expect(() => loadConfig({ ...prod, UNSUBSCRIBE_SECRET: 'short' })).toThrow(/UNSUBSCRIBE_SECRET/);
    const c = loadConfig({ ...prod, UNSUBSCRIBE_SECRETS_PREVIOUS: `${'p'.repeat(40)}, ${'q'.repeat(40)}` });
    expect(c.unsubscribeKeys).toEqual({ current: 'u'.repeat(48), all: ['u'.repeat(48), 'p'.repeat(40), 'q'.repeat(40)] });
    expect(() => loadConfig({ ...prod, UNSUBSCRIBE_SECRETS_PREVIOUS: 'tooshort' })).toThrow(/UNSUBSCRIBE_SECRETS_PREVIOUS/);
    // Outside production the session secret stands in (development and tests).
    const dev = loadConfig({ ...base, NODE_ENV: 'development' });
    expect(dev.unsubscribeKeys.current).toBe(dev.sessionSecret);
  });

  it('a link signed with a rotated-out key keeps working; an unknown key does not', async () => {
    const { issueUnsubscribeToken, verifyUnsubscribeToken } = await import('../modules/campaigns/application/unsubscribe.js');
    const claims = { orgId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', recipientId: '33333333-3333-4333-8333-333333333333' };
    const old = issueUnsubscribeToken('o'.repeat(40), claims);
    expect(verifyUnsubscribeToken(['n'.repeat(40), 'o'.repeat(40)], old)).toEqual(claims);
    expect(verifyUnsubscribeToken(['n'.repeat(40)], old)).toBeNull();
    expect(verifyUnsubscribeToken('o'.repeat(40), old)).toEqual(claims);
  });
});

describe('live delivery requirements (owner-authorized 2026-10-09; off unless set)', () => {
  const live = {
    ...prod,
    CAMPAIGN_DELIVERY_MODE: 'live',
    DELIVERY_PROVIDER: 'mailgun',
    MAILGUN_API_KEY: 'key-0123456789abcdef',
    DELIVERY_WEBHOOK_SIGNING_KEY: 'w'.repeat(32),
    DELIVERY_SPF_INCLUDE: 'include:mailgun.org',
    DELIVERY_DKIM_SELECTOR: 'mx',
  };

  it('is off by default; live without its settings fails boot naming every missing one', () => {
    expect(loadConfig(prod).campaignDeliveryMode).toBe('disabled');
    expect(loadConfig(prod).deliveryProvider).toBeNull();
    const err = (() => {
      try {
        loadConfig({ ...prod, CAMPAIGN_DELIVERY_MODE: 'live' });
      } catch (e) {
        return String(e);
      }
      return '';
    })();
    for (const key of ['DELIVERY_PROVIDER', 'MAILGUN_API_KEY', 'DELIVERY_WEBHOOK_SIGNING_KEY', 'DELIVERY_SPF_INCLUDE', 'DELIVERY_DKIM_SELECTOR']) {
      expect(err).toContain(`${key} is required for CAMPAIGN_DELIVERY_MODE=live`);
    }
  });

  it('a complete live configuration boots with the provider (US by default, EU selectable; https Mailgun only)', () => {
    const c = loadConfig(live);
    expect(c.campaignDeliveryMode).toBe('live');
    expect(c.deliveryProvider).toEqual({ name: 'mailgun', apiKey: 'key-0123456789abcdef', baseUrl: 'https://api.mailgun.net' });
    expect(loadConfig({ ...live, MAILGUN_BASE_URL: 'https://api.eu.mailgun.net' }).deliveryProvider?.baseUrl).toBe('https://api.eu.mailgun.net');
    expect(() => loadConfig({ ...live, MAILGUN_BASE_URL: 'http://evil.example' })).toThrow(/MAILGUN_BASE_URL/);
    expect(() => loadConfig({ ...live, DELIVERY_PROVIDER: 'sendgrid' })).toThrow(/DELIVERY_PROVIDER/);
    const { MAILGUN_API_KEY: _k, ...noKey } = live;
    expect(() => loadConfig({ ...noKey, CAMPAIGN_DELIVERY_MODE: undefined })).toThrow(/MAILGUN_API_KEY is required with DELIVERY_PROVIDER=mailgun/);
  });
});

describe('SMS and WhatsApp providers (messaging amendment)', () => {
  const sms = {
    SMS_PROVIDER: 'twilio',
    TWILIO_ACCOUNT_SID: `AC${'a1'.repeat(16)}`,
    TWILIO_AUTH_TOKEN: 't'.repeat(32),
    TWILIO_FROM: '+14155550000',
    TWILIO_STATUS_CALLBACK_URL: 'https://api.example.com/v1/webhooks/twilio',
  };
  const wa = {
    WHATSAPP_PROVIDER: 'meta',
    WHATSAPP_ACCESS_TOKEN: 'a'.repeat(40),
    WHATSAPP_PHONE_NUMBER_ID: '1234567890',
    WHATSAPP_APP_SECRET: 's'.repeat(32),
    WHATSAPP_VERIFY_TOKEN: 'v'.repeat(32),
  };

  it('are off unless configured; a complete configuration is exposed only through its provider block', () => {
    expect(loadConfig(prod).smsProvider).toBeNull();
    expect(loadConfig(prod).whatsappProvider).toBeNull();
    expect(loadConfig({ ...prod, ...sms }).smsProvider).toMatchObject({ name: 'twilio', from: '+14155550000', messagingServiceSid: null, statusCallbackUrl: sms.TWILIO_STATUS_CALLBACK_URL });
    expect(loadConfig({ ...prod, ...wa }).whatsappProvider).toMatchObject({ name: 'meta', phoneNumberId: '1234567890', apiVersion: 'v21.0' });
  });

  it('a partial or malformed provider configuration fails boot, naming what is wrong', () => {
    expect(() => loadConfig({ ...prod, SMS_PROVIDER: 'twilio' })).toThrow(/TWILIO_ACCOUNT_SID is required with SMS_PROVIDER=twilio/);
    expect(() => loadConfig({ ...prod, ...sms, TWILIO_MESSAGING_SERVICE_SID: `MG${'b2'.repeat(16)}` })).toThrow(/exactly one of TWILIO_FROM and TWILIO_MESSAGING_SERVICE_SID/);
    expect(() => loadConfig({ ...prod, ...sms, TWILIO_FROM: '4155550000' })).toThrow(/TWILIO_FROM/);
    expect(() => loadConfig({ ...prod, ...sms, TWILIO_STATUS_CALLBACK_URL: 'http://api.example.com/x' })).toThrow(/TWILIO_STATUS_CALLBACK_URL/);
    expect(() => loadConfig({ ...prod, ...sms, TWILIO_ACCOUNT_SID: 'ACnothex' })).toThrow(/TWILIO_ACCOUNT_SID/);
    expect(() => loadConfig({ ...prod, WHATSAPP_PROVIDER: 'meta' })).toThrow(/WHATSAPP_APP_SECRET is required with WHATSAPP_PROVIDER=meta/);
    expect(() => loadConfig({ ...prod, ...wa, WHATSAPP_PHONE_NUMBER_ID: '+1234' })).toThrow(/WHATSAPP_PHONE_NUMBER_ID/);
    expect(() => loadConfig({ ...prod, SMS_PROVIDER: 'plivo' })).toThrow(/SMS_PROVIDER/);
  });
});
