import { existsSync } from 'node:fs';
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
    TRUST_PROXY: z.string().optional(),
    REDIS_URL: z.string().optional(),
    MAIL_TRANSPORT: z.enum(['smtp', 'file']).optional(),
    MAIL_FROM: z.string().optional(),
    MAIL_FILE_DIR: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    const required = ['APP_URL', 'SESSION_SECRET', 'TRUST_PROXY', 'REDIS_URL', 'MAIL_FROM'] as const;
    for (const key of required) {
      if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required in production` });
    }
    if (env.SESSION_SECRET?.includes('development-only')) {
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
  trustProxy: TrustProxySetting;
  redisUrl: string | null;
  cookies: { secure: boolean; sessionName: string; csrfName: string };
  mail:
    | { transport: 'file'; from: string; dir: string }
    | { transport: 'smtp'; from: string; host: string; port: number; user?: string; pass?: string };
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(source);
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
    trustProxy: parseTrustProxy(pick('TRUST_PROXY', e.TRUST_PROXY)),
    redisUrl: e.REDIS_URL ?? null,
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
