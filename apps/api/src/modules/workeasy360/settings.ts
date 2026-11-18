/**
 * WorkEasy360 Accounts sign-in configuration (docs/workeasy360-sso.md §Environment). The names are those of the
 * integration kit's `.env.example` that Super Admin generates for the product. Off until WORKEASY360_ISSUER is set;
 * a half-configured or unsafe setting fails boot instead of half-working.
 */

/** Organization-scope roles someone may get on joining an existing organization. */
export const JOIN_ROLES = ['admin', 'member'] as const;
/** Workspace-scope roles for the organization's first workspace on joining (`none`: no workspace access). */
export const JOIN_WORKSPACE_ROLES = ['workspace_admin', 'manager', 'editor', 'analyst', 'viewer', 'none'] as const;

export interface Workeasy360Settings {
  /** Exactly the issuer WorkEasy360's discovery document names (no trailing slash). */
  issuer: string;
  clientId: string;
  /** Must equal the ID token's product_code. */
  productCode: string;
  /** The registered redirect URI, exactly: <APP_URL>/api/v1/auth/workeasy360/callback. */
  redirectUri: string;
  /** Registered post-logout URI on the app's origin (for "Sign out of WorkEasy360 too"). */
  postLogoutRedirectUri: string;
  /** The credential id (`kid` of the client assertion). */
  keyId: string;
  /** PEM file with the private key (RSA or EC P-256). Never in the repository or an image. */
  privateKeyFile: string;
  scopes: readonly string[];
  /** WorkEasy360 is the only way in: password sign-in is off and other sessions are refused. */
  ssoOnly: boolean;
  /** An organization's first WorkEasy360 sign-in creates its organization here (otherwise only operator-linked ones work). */
  provisionOrganizations: boolean;
  defaultRole: (typeof JOIN_ROLES)[number];
  /** Role in the organization's first workspace on joining; null: none. */
  defaultWorkspaceRole: Exclude<(typeof JOIN_WORKSPACE_ROLES)[number], 'none'> | null;
  /** Plain-http provider endpoints: only for a loopback issuer outside production. */
  allowInsecureRequests: boolean;
}

export interface Workeasy360Env {
  WORKEASY360_ISSUER?: string | undefined;
  WORKEASY360_CLIENT_ID?: string | undefined;
  WORKEASY360_PRODUCT_CODE?: string | undefined;
  WORKEASY360_REDIRECT_URI?: string | undefined;
  WORKEASY360_POST_LOGOUT_REDIRECT_URI?: string | undefined;
  WORKEASY360_KEY_ID?: string | undefined;
  WORKEASY360_PRIVATE_KEY_FILE?: string | undefined;
  WORKEASY360_SCOPES?: string | undefined;
  WORKEASY360_SSO_ONLY?: string | undefined;
  WORKEASY360_PROVISION_ORGANIZATIONS?: string | undefined;
  WORKEASY360_DEFAULT_ROLE?: string | undefined;
  WORKEASY360_DEFAULT_WORKSPACE_ROLE?: string | undefined;
}

export const DEFAULT_PRODUCT_CODE = 'workeasy_campaign';
export const DEFAULT_SCOPES = ['openid', 'email', 'profile', 'organization'];
export const CALLBACK_PATH = '/api/v1/auth/workeasy360/callback';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function flag(raw: string | undefined, name: string, fallback: boolean, problems: string[]): boolean {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === '') return fallback;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  problems.push(`${name}: use true or false`);
  return fallback;
}

function url(raw: string, name: string, problems: string[]): URL | null {
  try {
    return new URL(raw);
  } catch {
    problems.push(`${name}: not a URL`);
    return null;
  }
}

/** Parses and checks the WORKEASY360_* settings. Returns null when sign-in with WorkEasy360 is off. Throws on any problem. */
export function parseWorkeasy360Settings(env: Workeasy360Env, ctx: { appUrl: string; isProduction: boolean }): Workeasy360Settings | null {
  const problems: string[] = [];
  const get = (k: keyof Workeasy360Env) => {
    const v = env[k]?.trim();
    return v ? v : undefined;
  };
  const ssoOnly = flag(env.WORKEASY360_SSO_ONLY, 'WORKEASY360_SSO_ONLY', false, problems);
  const required = ['WORKEASY360_ISSUER', 'WORKEASY360_CLIENT_ID', 'WORKEASY360_KEY_ID', 'WORKEASY360_PRIVATE_KEY_FILE'] as const;
  const present = required.filter((k) => get(k));
  if (present.length === 0) {
    if (ssoOnly) problems.push('WORKEASY360_SSO_ONLY: needs WORKEASY360_ISSUER and the rest of the WorkEasy360 settings');
    if (problems.length) throw new Error(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    return null;
  }
  for (const k of required) if (!get(k)) problems.push(`${k}: required with ${present.join(', ')} (set all four, or none)`);

  const app = new URL(ctx.appUrl);
  const issuer = get('WORKEASY360_ISSUER') ?? '';
  let allowInsecureRequests = false;
  const issuerUrl = issuer ? url(issuer, 'WORKEASY360_ISSUER', problems) : null;
  if (issuerUrl) {
    if (issuer.endsWith('/')) problems.push('WORKEASY360_ISSUER: no trailing slash (it must equal the discovery document\'s issuer exactly)');
    if (issuerUrl.search || issuerUrl.hash) problems.push('WORKEASY360_ISSUER: no query or fragment');
    if (issuerUrl.protocol === 'http:') {
      if (ctx.isProduction) problems.push('WORKEASY360_ISSUER: must be https in production');
      else if (!LOOPBACK.has(issuerUrl.hostname)) problems.push('WORKEASY360_ISSUER: plain http only for a loopback issuer (127.0.0.1, localhost)');
      else allowInsecureRequests = true;
    } else if (issuerUrl.protocol !== 'https:') problems.push('WORKEASY360_ISSUER: must be https');
  }

  const productCode = get('WORKEASY360_PRODUCT_CODE') ?? DEFAULT_PRODUCT_CODE;
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(productCode)) problems.push('WORKEASY360_PRODUCT_CODE: lowercase letters, digits and underscores');

  const onAppOrigin = (raw: string, name: string): string => {
    const u = url(raw, name, problems);
    if (u && u.origin !== app.origin) problems.push(`${name}: must be on APP_URL's origin (${app.origin})`);
    if (u && ctx.isProduction && u.protocol !== 'https:') problems.push(`${name}: must be https in production`);
    return raw;
  };
  const redirectUri = onAppOrigin(get('WORKEASY360_REDIRECT_URI') ?? `${app.origin}${CALLBACK_PATH}`, 'WORKEASY360_REDIRECT_URI');
  if (url(redirectUri, 'WORKEASY360_REDIRECT_URI', [])?.pathname !== CALLBACK_PATH) {
    problems.push(`WORKEASY360_REDIRECT_URI: the callback is ${app.origin}${CALLBACK_PATH}`);
  }
  const postLogoutRedirectUri = onAppOrigin(get('WORKEASY360_POST_LOGOUT_REDIRECT_URI') ?? `${app.origin}/login`, 'WORKEASY360_POST_LOGOUT_REDIRECT_URI');

  const scopes = (get('WORKEASY360_SCOPES') ?? DEFAULT_SCOPES.join(' ')).split(/\s+/).filter(Boolean);
  // email_verified (a required claim) comes with the email scope.
  for (const s of ['openid', 'email']) if (!scopes.includes(s)) problems.push(`WORKEASY360_SCOPES: must include ${s}`);

  const defaultRole = (get('WORKEASY360_DEFAULT_ROLE') ?? 'member') as Workeasy360Settings['defaultRole'];
  if (!JOIN_ROLES.includes(defaultRole)) problems.push(`WORKEASY360_DEFAULT_ROLE: one of ${JOIN_ROLES.join(', ')}`);
  const workspaceRole = (get('WORKEASY360_DEFAULT_WORKSPACE_ROLE') ?? 'viewer') as (typeof JOIN_WORKSPACE_ROLES)[number];
  if (!JOIN_WORKSPACE_ROLES.includes(workspaceRole)) problems.push(`WORKEASY360_DEFAULT_WORKSPACE_ROLE: one of ${JOIN_WORKSPACE_ROLES.join(', ')}`);

  const clientId = get('WORKEASY360_CLIENT_ID') ?? '';
  const keyId = get('WORKEASY360_KEY_ID') ?? '';
  if (clientId.length > 255 || keyId.length > 255) problems.push('WORKEASY360_CLIENT_ID / WORKEASY360_KEY_ID: at most 255 characters');

  const provisionOrganizations = flag(env.WORKEASY360_PROVISION_ORGANIZATIONS, 'WORKEASY360_PROVISION_ORGANIZATIONS', true, problems);
  if (problems.length) throw new Error(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return {
    issuer,
    clientId,
    productCode,
    redirectUri,
    postLogoutRedirectUri,
    keyId,
    privateKeyFile: get('WORKEASY360_PRIVATE_KEY_FILE')!,
    scopes,
    ssoOnly,
    provisionOrganizations,
    defaultRole,
    defaultWorkspaceRole: workspaceRole === 'none' ? null : workspaceRole,
    allowInsecureRequests,
  };
}
