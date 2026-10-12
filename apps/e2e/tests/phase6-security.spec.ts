import { expect, type Page, test } from '@playwright/test';
import { linkFromMail } from './mailbox';

/**
 * Tenant-isolation attacks end to end (through the web proxy and the real API): another organization's campaign,
 * template, execution and analytics ids (IDOR), and pagination-cursor tampering and replay. Every attempt must be
 * DENIED without leaking data. Serial: the attacker reuses the victim's ids.
 */
const PASSWORD = 'maple-river-lantern-42';
const stamp = Date.now().toString(36);
const victim = { name: 'Vic Victim', email: `sec-victim-${stamp}@example.test`, org: 'Victim Co' };
const attacker = { name: 'Ada Attacker', email: `sec-attacker-${stamp}@example.test`, org: 'Attacker Co' };

test.describe.configure({ mode: 'serial' });
let vp: Page;
let ap: Page;
let vws = '';
let aws = '';
const ids = { campaign: '', template: '', execution: '' };

async function onboard(p: Page, who: typeof victim): Promise<string> {
  await p.goto('/register');
  await p.getByLabel('Your name').fill(who.name);
  await p.getByLabel('Work email').fill(who.email);
  await p.getByLabel('Password').fill(PASSWORD);
  await p.getByRole('button', { name: 'Create account' }).click();
  await expect(p.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
  await p.goto(await linkFromMail(who.email, 'verify_email'));
  await p.goto('/login');
  await p.getByLabel('Work email').fill(who.email);
  await p.getByLabel('Password').fill(PASSWORD);
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByLabel('Organization name').fill(who.org);
  await p.getByLabel('Workspace name').fill('Main');
  await p.getByRole('button', { name: 'Create organization' }).click();
  await expect(p).toHaveURL(/\/dashboard/);
  return ((await (await p.request.get('/api/v1/me/context')).json()) as { workspace: { id: string } }).workspace.id;
}
const csrf = async (p: Page) => (await p.context().cookies()).find((c) => c.name.endsWith('wk_csrf'))!.value;
async function call(p: Page, method: 'get' | 'post' | 'patch' | 'delete', url: string, data?: unknown) {
  const r = await p.request[method](`/api${url}`, method === 'get' ? {} : { data: data ?? {}, headers: { 'x-csrf-token': await csrf(p) } });
  return { status: r.status(), text: await r.text() };
}

test.beforeAll(async ({ browser }) => {
  vp = await (await browser.newContext()).newPage();
  ap = await (await browser.newContext()).newPage();
  vws = await onboard(vp, victim);
  aws = await onboard(ap, attacker);
  const V = (path: string) => `/v1/workspaces/${vws}${path}`;
  const topicId = JSON.parse((await call(vp, 'get', V('/topics'))).text).data.find((t: { key: string }) => t.key === 'marketing').id;
  const list = JSON.parse((await call(vp, 'post', V('/lists'), { name: 'Secret list' })).text).id;
  const contact = JSON.parse((await call(vp, 'post', V('/contacts'), { email: `secret-${stamp}@example.test`, firstName: 'Secretname' })).text).id;
  await call(vp, 'post', V(`/contacts/${contact}/consent`), { channel: 'email', action: 'subscribed', source: 'form', lawfulBasis: 'consent', evidenceNote: 'Form' });
  await call(vp, 'post', V(`/lists/${list}/members`), { contactIds: [contact] });
  const c = JSON.parse((await call(vp, 'post', V('/campaigns'), { name: 'Secret campaign', channel: 'email', topicId })).text);
  const p = JSON.parse(
    (await call(vp, 'patch', V(`/campaigns/${c.id}`), {
      expectedVersion: 1,
      audience: { include: [{ type: 'list', listId: list }], exclude: [] },
      sender: { senderIdentityId: null, fromName: 'Vic', replyTo: null },
      messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Secret subject', preheader: '', body: { format: 'text', text: 'Secret body' } } }],
    })).text,
  );
  const s = JSON.parse((await call(vp, 'post', V(`/campaigns/${c.id}/schedule`), { mode: 'now', expectedVersion: p.version })).text);
  ids.campaign = c.id;
  ids.execution = s.currentExecution.id;
  ids.template = JSON.parse((await call(vp, 'post', V('/templates'), { name: 'Secret template', content: { schema: 'email.content.v2', subject: 'Secret template subject', preheader: '', body: { format: 'blocks', blocks: [{ id: 'p1', type: 'paragraph', runs: [{ text: 'Secret' }] }] } } })).text).id;
});
test.afterAll(async () => {
  await vp.context().close();
  await ap.context().close();
});

const SECRETS = /Secret (campaign|subject|body|template)|Secretname|secret-/;

test('S1. another organization cannot read or change a campaign — neither via its own workspace path nor the victim’s', async () => {
  for (const ws of [aws, vws]) {
    const base = `/v1/workspaces/${ws}/campaigns/${ids.campaign}`;
    for (const [m, path, body] of [
      ['get', base, undefined],
      ['patch', base, { expectedVersion: 1, name: 'Owned' }],
      ['delete', base, { expectedVersion: 2 }], // a VALID body, so the tenant check — not validation — answers
      ['post', `${base}/clone`, { name: 'Stolen' }],
      ['post', `${base}/preview`, {}],
      ['post', `${base}/preflight`, {}],
      ['post', `${base}/cancel`, { expectedVersion: 1 }],
      ['get', `${base}/versions`, undefined],
      ['get', `${base}/executions/${ids.execution}`, undefined],
      ['get', `${base}/executions/${ids.execution}/recipients`, undefined],
    ] as const) {
      const r = await call(ap, m, path, body);
      expect([403, 404], `${m} ${path}`).toContain(r.status);
      expect(r.text).not.toMatch(SECRETS);
    }
  }
});

test('S2. another organization cannot read, apply or clone a template, nor see analytics', async () => {
  const mine = JSON.parse((await call(ap, 'post', `/v1/workspaces/${aws}/campaigns`, { name: 'Mine', channel: 'email' })).text);
  for (const [m, path, body] of [
    ['get', `/v1/workspaces/${aws}/templates/${ids.template}`, undefined],
    ['get', `/v1/workspaces/${vws}/templates/${ids.template}`, undefined],
    ['post', `/v1/workspaces/${aws}/templates`, { name: 'Stolen clone', fromTemplateId: ids.template }],
    ['post', `/v1/workspaces/${aws}/campaigns/${mine.id}/apply-template`, { templateId: ids.template, expectedVersion: 1 }],
    ['get', `/v1/workspaces/${vws}/campaigns/analytics`, undefined],
  ] as const) {
    const r = await call(ap, m, path, body);
    expect([403, 404], `${m} ${path}`).toContain(r.status);
    expect(r.text).not.toMatch(SECRETS);
  }
  // The attacker's own analytics exist and contain nothing of the victim's.
  const own = await call(ap, 'get', `/v1/workspaces/${aws}/campaigns/analytics`);
  expect(own.status).toBe(200);
  expect(JSON.parse(own.text).pipeline.runs).toBe(0);
});

test('S3. pagination cursors: forged, edited or replayed in another workspace are refused', async () => {
  for (const n of ['A', 'B']) await call(vp, 'post', `/v1/workspaces/${vws}/lists`, { name: `Page ${n}` });
  const page1 = JSON.parse((await call(vp, 'get', `/v1/workspaces/${vws}/lists?limit=1`)).text);
  const cursor: string = page1.nextCursor;
  expect((await call(vp, 'get', `/v1/workspaces/${vws}/lists?limit=1&cursor=${encodeURIComponent(cursor)}`)).status).toBe(200);
  const forged = Buffer.from(JSON.stringify({ t: '2026-10-08T00:00:00.000Z', id: page1.data[0].id })).toString('base64url');
  expect((await call(vp, 'get', `/v1/workspaces/${vws}/lists?cursor=${forged}`)).status).toBe(400);
  expect((await call(vp, 'get', `/v1/workspaces/${vws}/lists?cursor=${encodeURIComponent(cursor.slice(0, -3) + 'abc')}`)).status).toBe(400);
  expect((await call(ap, 'get', `/v1/workspaces/${aws}/lists?cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
  expect((await call(vp, 'get', `/v1/workspaces/${vws}/templates?cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
});

test('S4. the victim’s data is unchanged by every attempt', async () => {
  const c = JSON.parse((await call(vp, 'get', `/v1/workspaces/${vws}/campaigns/${ids.campaign}`)).text);
  expect(c.name).toBe('Secret campaign');
  expect(c.deletedAt).toBeNull();
  const t = JSON.parse((await call(vp, 'get', `/v1/workspaces/${vws}/templates/${ids.template}`)).text);
  expect(t).toMatchObject({ name: 'Secret template', version: 1 });
});
