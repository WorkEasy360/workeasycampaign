import { existsSync } from 'node:fs';
import { type DeliveryMode, resolveDeliveryMode } from '../modules/campaigns/domain/delivery-mode.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseTrustProxy, type TrustProxySetting } from './trust-proxy.js';

/**
 * Environment configuration. Fails closed:
 *  - NODE_ENV defaults to "production", so a missing NODE_ENV gets production strictness, never dev shortcuts.
 *  - In production every secret and topology setting must be set explicitly; there are no fallbacks.
 *  - Development/test fallbacks live ONLY in DEVELOPMENT_DEFAULTS and are never consulted in production.
 */
const DEVELOPMENT_DEFAULTS = {
  SESSION_SECRET: 'development-only-session-secret-do-not-use-in-production-0000',
  DATA_FINGERPRINT_SECRET: 'development-only-fingerprint-secret-do-not-use-in-production',
  // Next.js dev server proxies /api from the same machine.
  TRUST_PROXY: 'loopback',
  APP_URL: 'http://localhost:3000',
  MAIL_TRANSPORT: 'file',
  MAIL_FROM: 'Workeasy Campaign <no-reply@localhost>',
} as const;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    APP_URL: z.url().optional(),
    DATABASE_URL: z.string().min(1),
    IDENTITY_DATABASE_URL: z.string().min(1),
    SESSION_SECRET: z.string().min(32, { error: 'SESSION_SECRET must be at least 32 characters' }).optional(),
    /** Keyed hash for consent-evidence fingerprints (survive erasure without storing addresses). Do not rotate casually. */
    DATA_FINGERPRINT_SECRET: z.string().min(32, { error: 'DATA_FINGERPRINT_SECRET must be at least 32 characters' }).optional(),
    /** Where uploaded files (CSV imports) are stored. Development default: <repo>/.data/files. */
    FILE_STORE_DIR: z.string().optional(),
    IMPORT_MAX_BYTES: z.coerce.number().int().min(1024).max(200 * 1024 * 1024).default(20 * 1024 * 1024),
    IMPORT_MAX_ROWS: z.coerce.number().int().min(1).max(1_000_000).default(100_000),
    TRUST_PROXY: z.string().optional(),
    REDIS_URL: z.string().optional(),
    /**
     * Per-deployment rate-limit overrides, e.g. "auth.register=40,campaigns.preview=1200": known policy names only, limits
     * 1–100,000 (a NAT-ed office may exceed an IP limit; a test suite registers many users from 127.0.0.1). Defaults are
     * the values in code; an invalid value fails boot. See docs/security.md (rate limits).
     */
    RATE_LIMIT_OVERRIDES: z.string().max(2_000).optional(),
    /**
     * Campaign delivery capability (contract §9.3): disabled (default) | test (NODE_ENV=test only) | live (real sending:
     * requires DELIVERY_PROVIDER, MAILGUN_API_KEY, DELIVERY_WEBHOOK_SIGNING_KEY, DELIVERY_SPF_INCLUDE and
     * DELIVERY_DKIM_SELECTOR, or boot fails). Off unless explicitly set.
     */
    CAMPAIGN_DELIVERY_MODE: z.string().optional(),
    /** Scheduler tick for scheduled campaigns (Phase 7.5): 5–300 seconds; default 15. The worst-case start lag is about one tick. */
    CAMPAIGN_SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(300).default(15),
    /**
     * Background jobs (Phase 7.6, docs/architecture/durable-job-queue.md): "postgres" = the durable queue (REQUIRED in
     * production); "inline" = in-process (tests, single-process development). Default: postgres in production, inline
     * otherwise.
     */
    JOB_QUEUE: z.enum(['inline', 'postgres']).optional(),
    /** Comma-separated roles of this process: http, jobs, scheduler (default: all). A worker deployment: "jobs,scheduler". */
    PROCESS_ROLES: z.string().max(100).optional(),
    /** Jobs run at once per process with the jobs role (durable queue). */
    JOB_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    /**
     * What the email provider needs in a customer's DNS (Phase 7.8b): the SPF mechanism (e.g. "include:mailgun.org") and
     * the DKIM selector (e.g. "mx"). Without them a sending domain can never be verified (checks are "not_checked").
     */
    DELIVERY_SPF_INCLUDE: z.string().trim().regex(/^(include|a|mx|ip4|ip6):[A-Za-z0-9.:/_-]{1,200}$/, { error: 'e.g. include:mailgun.org' }).optional(),
    DELIVERY_DKIM_SELECTOR: z.string().trim().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i, { error: 'a DNS label, e.g. mx' }).optional(),
    /**
     * The email provider's webhook signing key (Phase 7.9). Without it, delivery webhooks are not accepted (404): no
     * bounce, complaint or engagement feedback is recorded.
     */
    DELIVERY_WEBHOOK_SIGNING_KEY: z.string().min(16, { error: 'at least 16 characters' }).max(200).optional(),
    /**
     * Provider open/click tracking (Phase 7.10): comma-separated "opens", "clicks" (default: none). Requested on every
     * message; analytics report opens/clicks only when tracked (otherwise "not tracked", never zero).
     */
    DELIVERY_TRACKING: z.string().trim().regex(/^((opens|clicks)(,(opens|clicks))?)?$/, { error: 'opens, clicks, or both' }).optional(),
    /**
     * Sending rates (Phase 7.11), per second, shared by every worker: the provider account's limit, and each workspace's
     * fair share (one large send cannot take the whole provider limit). Unset = no limit at that level.
     */
    DELIVERY_RATE_PER_SECOND: z.coerce.number().int().min(1).max(100_000).optional(),
    WORKSPACE_SEND_RATE_PER_SECOND: z.coerce.number().int().min(1).max(100_000).optional(),
    /** Bearer token for GET /metrics (Phase 7.12). Unset = no metrics endpoint. Never logged. */
    METRICS_TOKEN: z.string().min(24, { error: 'at least 24 characters' }).max(200).optional(),
    /**
     * Key of the unsubscribe links in sent emails (Phase 7.8; Gate G). Separate from SESSION_SECRET so a session-secret
     * rotation never breaks the links in emails already delivered. Rotation: set a new key and move the old one to
     * UNSUBSCRIBE_SECRETS_PREVIOUS (comma-separated) — links signed with either keep working. Required in production.
     */
    UNSUBSCRIBE_SECRET: z.string().min(32, { error: 'at least 32 characters' }).max(200).optional(),
    UNSUBSCRIBE_SECRETS_PREVIOUS: z.string().max(2000).optional(),
    /**
     * The email provider for campaign delivery (live mode). Only "mailgun" today. Its API key is a secret; the region is
     * chosen by the base URL (US or EU). Each customer sending domain must also be added to the provider account.
     */
    DELIVERY_PROVIDER: z.enum(['mailgun']).optional(),
    MAILGUN_API_KEY: z.string().min(10).max(200).optional(),
    MAILGUN_BASE_URL: z.enum(['https://api.mailgun.net', 'https://api.eu.mailgun.net']).default('https://api.mailgun.net'),
    /**
     * SMS provider (messaging amendment): Twilio Programmable Messaging. Secrets: the auth token. Sender: a Twilio number
     * (E.164) or a Messaging Service SID. TWILIO_STATUS_CALLBACK_URL is the exact public URL of /v1/webhooks/twilio
     * (Twilio signs it; delivery status is tracked through it).
     */
    SMS_PROVIDER: z.enum(['twilio']).optional(),
    TWILIO_ACCOUNT_SID: z.string().regex(/^AC[0-9a-f]{32}$/, { error: 'AC followed by 32 hex characters' }).optional(),
    TWILIO_AUTH_TOKEN: z.string().min(16).max(200).optional(),
    TWILIO_FROM: z.string().regex(/^\+[1-9]\d{6,14}$/, { error: 'an E.164 number, e.g. +14155550123' }).optional(),
    TWILIO_MESSAGING_SERVICE_SID: z.string().regex(/^MG[0-9a-f]{32}$/, { error: 'MG followed by 32 hex characters' }).optional(),
    TWILIO_STATUS_CALLBACK_URL: z.url({ protocol: /^https$/ }).optional(),
    /**
     * WhatsApp provider (messaging amendment): Meta WhatsApp Business Cloud API. Secrets: the access token (system user)
     * and the app secret (webhook signatures). WHATSAPP_VERIFY_TOKEN answers Meta's webhook subscription challenge.
     */
    WHATSAPP_PROVIDER: z.enum(['meta']).optional(),
    WHATSAPP_ACCESS_TOKEN: z.string().min(20).max(1000).optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d{5,20}$/).optional(),
    WHATSAPP_APP_SECRET: z.string().min(16).max(200).optional(),
    WHATSAPP_VERIFY_TOKEN: z.string().min(16).max(200).optional(),
    WHATSAPP_API_VERSION: z.string().regex(/^v\d{1,2}\.\d$/).default('v21.0'),
    MAIL_TRANSPORT: z.enum(['smtp', 'file']).optional(),
    MAIL_FROM: z.string().optional(),
    MAIL_FILE_DIR: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // Live delivery (any environment): everything real sending depends on must be configured, or boot fails.
    if ((env.CAMPAIGN_DELIVERY_MODE ?? '').trim() === 'live') {
      const needed = ['DELIVERY_PROVIDER', 'MAILGUN_API_KEY', 'DELIVERY_WEBHOOK_SIGNING_KEY', 'DELIVERY_SPF_INCLUDE', 'DELIVERY_DKIM_SELECTOR'] as const;
      for (const key of needed) if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required for CAMPAIGN_DELIVERY_MODE=live` });
    }
    if (env.DELIVERY_PROVIDER && !env.MAILGUN_API_KEY) ctx.addIssue({ code: 'custom', path: ['MAILGUN_API_KEY'], message: 'MAILGUN_API_KEY is required with DELIVERY_PROVIDER=mailgun' });
    // A configured provider must be complete: a partial one would look available and fail every send.
    if (env.SMS_PROVIDER) {
      for (const key of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_STATUS_CALLBACK_URL'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required with SMS_PROVIDER=twilio` });
      }
      if (!env.TWILIO_FROM === !env.TWILIO_MESSAGING_SERVICE_SID) ctx.addIssue({ code: 'custom', path: ['TWILIO_FROM'], message: 'Set exactly one of TWILIO_FROM and TWILIO_MESSAGING_SERVICE_SID' });
    }
    if (env.WHATSAPP_PROVIDER) {
      for (const key of ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required with WHATSAPP_PROVIDER=meta` });
      }
    }
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    const required = ['APP_URL', 'SESSION_SECRET', 'DATA_FINGERPRINT_SECRET', 'UNSUBSCRIBE_SECRET', 'FILE_STORE_DIR', 'TRUST_PROXY', 'REDIS_URL', 'MAIL_FROM'] as const;
    for (const key of required) {
      if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required in production` });
    }
    if (env.SESSION_SECRET?.includes('development-only') || env.DATA_FINGERPRINT_SECRET?.includes('development-only')) {
      ctx.addIssue({ code: 'custom', path: ['SESSION_SECRET'], message: 'development secret used in production' });
    }
    if (env.MAIL_TRANSPORT !== 'smtp') {
      ctx.addIssue({ code: 'custom', path: ['MAIL_TRANSPORT'], message: 'production must send mail via smtp' });
    }
    if (env.APP_URL && !env.APP_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['APP_URL'], message: 'APP_URL must be https in production' });
    }
  });

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  appUrl: string;
  appOrigin: string;
  databaseUrl: string;
  identityDatabaseUrl: string;
  sessionSecret: string;
  fingerprintSecret: string;
  fileStoreDir: string;
  imports: { maxBytes: number; maxRows: number };
  trustProxy: TrustProxySetting;
  redisUrl: string | null;
  /** Server-enforced campaign delivery capability; never derived from a request. */
  campaignDeliveryMode: DeliveryMode;
  /** Policy name → limit (see RATE_LIMIT_OVERRIDES). */
  rateLimitOverrides: Readonly<Record<string, number>>;
  /** Scheduler tick in ms (CAMPAIGN_SCHEDULER_INTERVAL_SECONDS). */
  campaignSchedulerIntervalMs: number;
  jobQueue: 'inline' | 'postgres';
  /** Provider DNS requirements for sending-domain verification (null: not configured → never verified). */
  deliveryDns: { spfInclude: string | null; dkimSelector: string | null };
  /** Provider webhook signing key; null = webhooks disabled. Never logged. */
  deliveryWebhookSigningKey: string | null;
  /** Bearer token for /metrics; null = endpoint disabled. */
  metricsToken: string | null;
  /** Campaign delivery provider (live mode); null = none configured. The key is a secret: never logged. */
  deliveryProvider: { name: 'mailgun'; apiKey: string; baseUrl: string } | null;
  /** SMS provider (Twilio); null = SMS not configured. Secrets never logged. */
  smsProvider: { name: 'twilio'; accountSid: string; authToken: string; from: string | null; messagingServiceSid: string | null; statusCallbackUrl: string } | null;
  /** WhatsApp provider (Meta Cloud API); null = WhatsApp not configured. Secrets never logged. */
  whatsappProvider: { name: 'meta'; accessToken: string; phoneNumberId: string; appSecret: string; verifyToken: string; apiVersion: string } | null;
  /** Unsubscribe link keys: `current` signs, every key (current first) verifies. */
  unsubscribeKeys: { current: string; all: readonly string[] };
  /** Provider open/click tracking requested per message. */
  deliveryTracking: { opens: boolean; clicks: boolean };
  /** Sending rates per second (null = no limit at that level). */
  sendRates: { providerPerSecond: number | null; workspacePerSecond: number | null };
  processRoles: ReadonlySet<ProcessRole>;
  jobConcurrency: number;
  cookies: { secure: boolean; sessionName: string; csrfName: string };
  mail:
    | { transport: 'file'; from: string; dir: string }
    | { transport: 'smtp'; from: string; host: string; port: number; user?: string; pass?: string };
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // A blank value means "not set" (dotenv convention): `.env.example` lists optional settings as `KEY=`, and a copy of
  // it must boot. Required settings still fail when blank (they are then missing).
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(source).filter(([, v]) => v === undefined || v.trim() !== '')));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  const dev = isProduction ? undefined : DEVELOPMENT_DEFAULTS;
  const pick = <K extends keyof typeof DEVELOPMENT_DEFAULTS>(key: K, value: string | undefined): string => {
    const v = value ?? dev?.[key];
    if (v === undefined) throw new Error(`${key} is required`);
    return v;
  };

  const appUrl = pick('APP_URL', e.APP_URL);
  const transport = (e.MAIL_TRANSPORT ?? dev?.MAIL_TRANSPORT ?? 'smtp') as 'smtp' | 'file';
  const from = pick('MAIL_FROM', e.MAIL_FROM);

  return {
    env: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    appUrl,
    appOrigin: new URL(appUrl).origin,
    databaseUrl: e.DATABASE_URL,
    identityDatabaseUrl: e.IDENTITY_DATABASE_URL,
    sessionSecret: pick('SESSION_SECRET', e.SESSION_SECRET),
    fingerprintSecret: pick('DATA_FINGERPRINT_SECRET', e.DATA_FINGERPRINT_SECRET),
    fileStoreDir: e.FILE_STORE_DIR || resolve(repoRoot, '.data', 'files'),
    imports: { maxBytes: e.IMPORT_MAX_BYTES, maxRows: e.IMPORT_MAX_ROWS },
    trustProxy: parseTrustProxy(pick('TRUST_PROXY', e.TRUST_PROXY)),
    redisUrl: e.REDIS_URL ?? null,
    // Boot fails on any value that would enable delivery outside tests (resolveDeliveryMode throws).
    campaignDeliveryMode: resolveDeliveryMode(e.CAMPAIGN_DELIVERY_MODE, e.NODE_ENV),
    rateLimitOverrides: parseRateLimitOverrides(e.RATE_LIMIT_OVERRIDES),
    campaignSchedulerIntervalMs: e.CAMPAIGN_SCHEDULER_INTERVAL_SECONDS * 1_000,
    jobQueue: resolveJobQueue(e.JOB_QUEUE, isProduction),
    deliveryDns: { spfInclude: e.DELIVERY_SPF_INCLUDE ?? null, dkimSelector: e.DELIVERY_DKIM_SELECTOR ?? null },
    deliveryWebhookSigningKey: e.DELIVERY_WEBHOOK_SIGNING_KEY ?? null,
    metricsToken: e.METRICS_TOKEN ?? null,
    deliveryProvider: e.DELIVERY_PROVIDER && e.MAILGUN_API_KEY ? { name: e.DELIVERY_PROVIDER, apiKey: e.MAILGUN_API_KEY, baseUrl: e.MAILGUN_BASE_URL } : null,
    smsProvider:
      e.SMS_PROVIDER && e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_STATUS_CALLBACK_URL
        ? { name: e.SMS_PROVIDER, accountSid: e.TWILIO_ACCOUNT_SID, authToken: e.TWILIO_AUTH_TOKEN, from: e.TWILIO_FROM ?? null, messagingServiceSid: e.TWILIO_MESSAGING_SERVICE_SID ?? null, statusCallbackUrl: e.TWILIO_STATUS_CALLBACK_URL }
        : null,
    whatsappProvider:
      e.WHATSAPP_PROVIDER && e.WHATSAPP_ACCESS_TOKEN && e.WHATSAPP_PHONE_NUMBER_ID && e.WHATSAPP_APP_SECRET && e.WHATSAPP_VERIFY_TOKEN
        ? { name: e.WHATSAPP_PROVIDER, accessToken: e.WHATSAPP_ACCESS_TOKEN, phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID, appSecret: e.WHATSAPP_APP_SECRET, verifyToken: e.WHATSAPP_VERIFY_TOKEN, apiVersion: e.WHATSAPP_API_VERSION }
        : null,
    unsubscribeKeys: unsubscribeKeys(e.UNSUBSCRIBE_SECRET ?? pick('SESSION_SECRET', e.SESSION_SECRET), e.UNSUBSCRIBE_SECRETS_PREVIOUS),
    sendRates: { providerPerSecond: e.DELIVERY_RATE_PER_SECOND ?? null, workspacePerSecond: e.WORKSPACE_SEND_RATE_PER_SECOND ?? null },
    deliveryTracking: { opens: (e.DELIVERY_TRACKING ?? '').split(',').includes('opens'), clicks: (e.DELIVERY_TRACKING ?? '').split(',').includes('clicks') },
    processRoles: parseProcessRoles(e.PROCESS_ROLES),
    jobConcurrency: e.JOB_CONCURRENCY,
    cookies: isProduction
      ? // __Host- prefix: browser enforces Secure, Path=/ and no Domain, so subdomains cannot plant or read it.
        { secure: true, sessionName: '__Host-wk_session', csrfName: '__Host-wk_csrf' }
      : { secure: false, sessionName: 'wk_session', csrfName: 'wk_csrf' },
    mail:
      transport === 'file'
        ? { transport, from, dir: e.MAIL_FILE_DIR ?? resolve(repoRoot, '.dev-mail') }
        : {
            transport,
            from,
            host: e.SMTP_HOST ?? 'localhost',
            port: e.SMTP_PORT ?? 587,
            user: e.SMTP_USER,
            pass: e.SMTP_PASS,
          },
  };
}

/** Loads the repository .env in development only. Production configuration comes from the real environment. */
export function loadDotEnvForDevelopment(): void {
  const envFile = resolve(repoRoot, '.env');
  if ((process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') && existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
}

export type ProcessRole = 'http' | 'jobs' | 'scheduler';
const PROCESS_ROLES: readonly ProcessRole[] = ['http', 'jobs', 'scheduler'];

/** Production must use the durable queue: an in-process queue loses jobs on restart (boot fails otherwise). */
export function resolveJobQueue(raw: 'inline' | 'postgres' | undefined, isProduction: boolean): 'inline' | 'postgres' {
  const q = raw ?? (isProduction ? 'postgres' : 'inline');
  if (isProduction && q !== 'postgres') throw new Error('JOB_QUEUE must be "postgres" in production (the in-process queue loses jobs on restart)');
  return q;
}

/** Parses PROCESS_ROLES ("http,jobs,scheduler"); unknown roles or an empty set fail boot. Default: all roles. */
export function parseProcessRoles(raw: string | undefined): ReadonlySet<ProcessRole> {
  if (!raw?.trim()) return new Set(PROCESS_ROLES);
  const roles = raw.split(',').map((r) => r.trim()).filter(Boolean);
  const bad = roles.filter((r) => !PROCESS_ROLES.includes(r as ProcessRole));
  if (bad.length || !roles.length) throw new Error(`PROCESS_ROLES: unknown role(s) ${bad.join(', ') || '(none given)'}; use ${PROCESS_ROLES.join(', ')}`);
  return new Set(roles as ProcessRole[]);
}

/** Parses RATE_LIMIT_OVERRIDES ("name=limit,…"). Strict: an unknown shape or out-of-range value throws (boot fails). */
export function parseRateLimitOverrides(raw: string | undefined): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!raw?.trim()) return out;
  for (const part of raw.split(',')) {
    const m = /^\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\s*=\s*(\d{1,6})\s*$/.exec(part);
    const limit = m ? Number(m[2]) : NaN;
    if (!m || limit < 1 || limit > 100_000) {
      throw new Error(`RATE_LIMIT_OVERRIDES: invalid entry "${part.trim()}" (expected name=limit, limit 1-100000)`);
    }
    out[m[1]!] = limit;
  }
  return Object.freeze(out);
}

/** Current key first; previous keys (comma-separated, each ≥ 32 characters) verify links issued before a rotation. */
export function unsubscribeKeys(current: string, previous: string | undefined): { current: string; all: readonly string[] } {
  const prev = (previous ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  for (const k of prev) if (k.length < 32) throw new Error('Invalid configuration:\n  UNSUBSCRIBE_SECRETS_PREVIOUS: each key needs at least 32 characters');
  return { current, all: [current, ...prev.filter((k) => k !== current)] };
}
