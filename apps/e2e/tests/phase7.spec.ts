import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { linkFromMail } from './mailbox';

/**
 * Phase 7 Gate C screens in a real browser against the real API: a run's sending speed (7.11), a campaign's results
 * (7.10: "not tracked" stated, never zeros, without a provider), and organization usage (7.13). Each screen is also
 * checked for WCAG 2.1 A/AA violations (axe), with the same tags as the earlier suites.
 */
const PASSWORD = 'maple-river-lantern-42';
const stamp = Date.now().toString(36);
const user = { name: 'Pia Seven', email: `phase7-${stamp}@example.test` };

test.describe.configure({ mode: 'serial' });
let page: Page;
let ws = '';
let listId = '';
let topicId = '';

async function violations(p: Page): Promise<string[]> {
  await expect(p.getByText(/^Loading/)).toHaveCount(0);
  const result = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
}
const expectNoViolations = async (p: Page, label: string) => expect(await violations(p), `${label} accessibility violations`).toEqual([]);
const csrf = async () => (await page.context().cookies()).find((c) => c.name.endsWith('wk_csrf'))!.value;
async function api(method: 'get' | 'post' | 'patch', path: string, data?: unknown) {
  const r = await page.request[method](`/api/v1/workspaces/${ws}${path}`, method === 'get' ? {} : { data: data ?? {}, headers: { 'x-csrf-token': await csrf() } });
  return (await r.json()) as any;
}
async function campaign(name: string) {
  const c = await api('post', '/campaigns', { name, channel: 'email', topicId });
  const p = await api('patch', `/campaigns/${c.id}`, {
    expectedVersion: 1,
    audience: { include: [{ type: 'list', listId }], exclude: [] },
    sender: { senderIdentityId: null, fromName: 'Pia', replyTo: null },
    messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Hello', preheader: '', body: { format: 'text', text: 'Hi there' } } }],
  });
  return { id: c.id as string, version: p.version as number };
}

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  await page.goto('/register');
  await page.getByLabel('Your name').fill(user.name);
  await page.getByLabel('Work email').fill(user.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
  await page.goto(await linkFromMail(user.email, 'verify_email'));
  await page.goto('/login');
  await page.getByLabel('Work email').fill(user.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Organization name').fill('Seven Co');
  await page.getByLabel('Workspace name').fill('Main');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  ws = ((await (await page.request.get('/api/v1/me/context')).json()) as { workspace: { id: string } }).workspace.id;
  topicId = (await api('get', '/topics')).data.find((t: { key: string }) => t.key === 'marketing').id;
  listId = (await api('post', '/lists', { name: 'Readers' })).id;
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const c = await api('post', '/contacts', { email: `p7-${i}-${stamp}@example.test` });
    await api('post', `/contacts/${c.id}/consent`, { channel: 'email', action: 'subscribed', source: 'form', lawfulBasis: 'consent', evidenceNote: 'Form' });
    ids.push(c.id);
  }
  await api('post', `/lists/${listId}/members`, { contactIds: ids });
});
test.afterAll(async () => page.context().close());

test('a scheduled run: set and remove its sending speed', async () => {
  const c = await campaign('Paced newsletter');
  const s = await api('post', `/campaigns/${c.id}/schedule`, { mode: 'at', sendAt: new Date(Date.now() + 86_400_000).toISOString(), expectedVersion: c.version });
  expect(s.status).toBe('scheduled');
  await page.goto(`/campaigns/${c.id}`);
  const speed = page.getByRole('form', { name: 'Sending speed' });
  await expect(speed.getByText('No campaign limit')).toBeVisible();
  await speed.getByLabel('Messages per hour').fill('500');
  await speed.getByRole('button', { name: 'Set limit' }).click();
  await expect(speed.getByText('At most 500 per hour')).toBeVisible();
  await expectNoViolations(page, 'campaign with sending speed');
  await speed.getByRole('button', { name: 'Remove limit' }).click();
  await expect(speed.getByText('No campaign limit')).toBeVisible();
});

test('a sent campaign shows its results; without a provider, engagement is "not tracked" — never zeros', async () => {
  const c = await campaign('Sent newsletter');
  const s = await api('post', `/campaigns/${c.id}/schedule`, { mode: 'now', expectedVersion: c.version });
  await expect.poll(async () => (await api('get', `/campaigns/${c.id}/executions/${s.currentExecution.id}`)).status, { timeout: 30_000 }).toBe('completed');
  await page.goto(`/campaigns/${c.id}`);
  const results = page.getByRole('region', { name: 'Results' });
  await expect(results.getByText('Sent', { exact: true })).toBeVisible();
  await expect(results.getByText(/not tracked in this workspace/)).toBeVisible();
  await expect(results.getByText('Open rate')).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'Sending speed' })).toHaveCount(0); // finished: nothing to change
  await expectNoViolations(page, 'campaign results');
});

test('organization usage: the run is metered; quantities only', async () => {
  await page.goto('/settings/usage');
  const sends = page.locator('dt', { hasText: 'Campaign sends' }).locator('..');
  await expect(sends.locator('dd').first()).toHaveText(/^[1-9]\d*$/);
  await expect(page.getByText(/test sends are never counted/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Usage' })).toHaveAttribute('aria-current', 'page');
  await expectNoViolations(page, 'usage');
});
