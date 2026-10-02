import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { resetTestDatabase, testDatabaseUrls, withOwnerConnection } from '@workeasy/db/testing';
import { createApp } from '../src/app.factory.js';
import { loadConfig } from '../src/config/env.js';
import type { MailMessage, Mailer } from '../src/infrastructure/mail/mailer.js';
import { MemoryRateLimitStore } from '../src/common/rate-limit.js';

export class CapturingMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(m: MailMessage) {
    this.sent.push(m);
  }
  last(to: string, tag: string): MailMessage {
    const m = [...this.sent].reverse().find((x) => x.to.toLowerCase() === to.toLowerCase() && x.tag === tag);
    if (!m) throw new Error(`no ${tag} mail to ${to}; sent: ${this.sent.map((s) => `${s.tag}->${s.to}`).join(', ')}`);
    return m;
  }
  tokenFrom(to: string, tag: string): string {
    const link = this.last(to, tag).link!;
    return new URL(link).searchParams.get('token')!;
  }
}

export interface TestApp {
  app: NestFastifyApplication;
  mailer: CapturingMailer;
  close(): Promise<void>;
}

export const APP_ORIGIN = 'http://localhost:3000';

export async function startTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const urls = testDatabaseUrls();
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: urls.app,
    IDENTITY_DATABASE_URL: urls.identity,
    SESSION_SECRET: 'test-secret-test-secret-test-secret-0123456789',
    TRUST_PROXY: 'false',
    APP_URL: APP_ORIGIN,
    ...env,
  });
  const mailer = new CapturingMailer();
  const app = await createApp(config, { mailer, rateLimitStore: new MemoryRateLimitStore() });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, mailer, close: () => app.close() };
}

export { resetTestDatabase, withOwnerConnection };

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | undefined>;
  setCookies: string[];
}

/** A browser-like client: keeps cookies, fetches and sends the CSRF token on unsafe requests. */
let ipSeq = 0;
/** Each agent is a distinct client address (TEST-NET-2), like real browsers. */
const nextIp = () => `198.51.100.${(++ipSeq % 250) + 1}`;

export class Agent {
  private cookies = new Map<string, string>();
  constructor(
    private readonly t: TestApp,
    readonly ip = nextIp(),
  ) {}

  cookie(name: string) {
    return this.cookies.get(name);
  }

  setCookie(name: string, value: string) {
    this.cookies.set(name, value);
  }

  async request<T = any>(
    method: string,
    url: string,
    body?: unknown,
    opts: { headers?: Record<string, string>; csrf?: boolean } = {},
  ): Promise<Res<T>> {
    const unsafe = !['GET', 'HEAD'].includes(method);
    if (unsafe && opts.csrf !== false && !this.cookies.has('wk_csrf')) await this.request('GET', '/v1/auth/csrf');
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (unsafe && opts.csrf !== false && this.cookies.get('wk_csrf')) headers['x-csrf-token'] = this.cookies.get('wk_csrf')!;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.t.app.getHttpAdapter().getInstance().inject({
      method: method as 'GET',
      url,
      headers,
      payload: body === undefined ? undefined : JSON.stringify(body),
      remoteAddress: this.ip,
    });
    const raw = res.headers['set-cookie'];
    const setCookies = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    for (const c of setCookies) {
      const [pair, ...attrs] = c.split(';');
      const [name, ...rest] = pair!.split('=');
      const value = rest.join('=');
      const expired = attrs.some((a) => /max-age=0/i.test(a.trim()) || /expires=thu, 01 jan 1970/i.test(a.trim()));
      if (!value || expired) this.cookies.delete(name!.trim());
      else this.cookies.set(name!.trim(), value);
    }
    let parsed: unknown = res.body;
    try {
      parsed = res.body ? JSON.parse(res.body) : undefined;
    } catch {
      // non-JSON (CSV)
    }
    return { status: res.statusCode, body: parsed as T, headers: res.headers as Res['headers'], setCookies };
  }

  get<T = any>(url: string) {
    return this.request<T>('GET', url);
  }
  post<T = any>(url: string, body?: unknown, opts?: { headers?: Record<string, string>; csrf?: boolean }) {
    return this.request<T>('POST', url, body ?? {}, opts);
  }
  patch<T = any>(url: string, body: unknown) {
    return this.request<T>('PATCH', url, body);
  }
  put<T = any>(url: string, body: unknown) {
    return this.request<T>('PUT', url, body);
  }
  delete<T = any>(url: string, body?: unknown) {
    return this.request<T>('DELETE', url, body);
  }
}

export const PASSWORD = 'maple-river-lantern-42';

let seq = 0;
export const uniqueEmail = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}@example.test`;

/** Register → verify (via captured email) → sign in. */
export async function signUp(t: TestApp, email = uniqueEmail('user'), name = 'Test User'): Promise<Agent> {
  const agent = new Agent(t);
  const reg = await agent.post('/v1/auth/register', { email, password: PASSWORD, displayName: name });
  if (reg.status !== 202) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  const v = await agent.post('/v1/auth/verify-email', { token: t.mailer.tokenFrom(email, 'verify_email') });
  if (v.status !== 200) throw new Error(`verify failed: ${JSON.stringify(v.body)}`);
  const login = await agent.post('/v1/auth/login', { email, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login failed: ${JSON.stringify(login.body)}`);
  (agent as Agent & { email: string }).email = email;
  return agent;
}

export function emailOf(agent: Agent): string {
  return (agent as Agent & { email: string }).email;
}

export async function createOrg(agent: Agent, name = 'Acme') {
  const r = await agent.post('/v1/organizations', { name, workspace: { name: 'Main' } });
  if (r.status !== 201) throw new Error(`create org failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { orgId: r.body.organization.id as string, workspaceId: r.body.workspace.id as string };
}

export async function roleId(agent: Agent, orgId: string, key: string): Promise<string> {
  const r = await agent.get(`/v1/organizations/${orgId}/roles`);
  const role = r.body.data.find((x: { key: string }) => x.key === key);
  if (!role) throw new Error(`role ${key} not found`);
  return role.id;
}

export async function userIdOf(agent: Agent): Promise<string> {
  return (await agent.get('/v1/me')).body.user.id;
}

/** Owner invites `invitee` (already signed up) and the invitee accepts. */
export async function inviteAndAccept(
  t: TestApp,
  owner: Agent,
  invitee: Agent,
  orgId: string,
  orgRoleKey: string,
  workspaces: { workspaceId: string; roleKey: string }[] = [],
) {
  const body = {
    email: emailOf(invitee),
    organizationRoleId: await roleId(owner, orgId, orgRoleKey),
    workspaces: await Promise.all(workspaces.map(async (w) => ({ workspaceId: w.workspaceId, roleId: await roleId(owner, orgId, w.roleKey) }))),
  };
  const inv = await owner.post(`/v1/organizations/${orgId}/invitations`, body);
  if (inv.status !== 201) throw new Error(`invite failed: ${inv.status} ${JSON.stringify(inv.body)}`);
  const accepted = await invitee.post('/v1/invitations/accept', { token: t.mailer.tokenFrom(emailOf(invitee), 'invitation') });
  if (accepted.status !== 200) throw new Error(`accept failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
}
