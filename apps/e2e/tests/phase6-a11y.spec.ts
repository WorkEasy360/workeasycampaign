import AxeBuilder from '@axe-core/playwright';
import { withOwnerConnection } from '@workeasy/db/testing';
import { expect, type Page, test } from '@playwright/test';
import { linkFromMail } from './mailbox';

/**
 * Phase 6 accessibility (flow 21): WCAG 2.1 A/AA (axe) on every campaign screen and dialog, plus keyboard behaviour
 * of the campaign dialogs. Same helper and tags as the Phase 5 accessibility suite.
 */
const PASSWORD = 'maple-river-lantern-42';
const stamp = Date.now().toString(36);
const user = { name: 'Ada Access', email: `camp-a11y-${stamp}@example.test` };

test.describe.configure({ mode: 'serial' });
let page: Page;
let ws = '';
let draftId = '';

async function violations(p: Page): Promise<string[]> {
  await expect(p.getByText(/^Loading/)).toHaveCount(0);
  await expect(p.getByText(/^Checking/)).toHaveCount(0);
  const result = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
}
const expectNoViolations = async (p: Page, label: string) => expect(await violations(p), `${label} accessibility violations`).toEqual([]);
const csrf = async () => (await page.context().cookies()).find((c) => c.name.endsWith('wk_csrf'))!.value;
async function api(method: 'get' | 'post' | 'patch', path: string, data?: unknown) {
  const r = await page.request[method](`/api/v1/workspaces/${ws}${path}`, method === 'get' ? {} : { data: data ?? {}, headers: { 'x-csrf-token': await csrf() } });
  return (await r.json()) as any;
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
  await page.getByLabel('Organization name').fill('A11y Co');
  await page.getByLabel('Workspace name').fill('Main');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  ws = ((await (await page.request.get('/api/v1/me/context')).json()) as { workspace: { id: string } }).workspace.id;
  const topicId = (await api('get', '/topics')).data.find((t: { key: string }) => t.key === 'marketing').id;
  const list = (await api('post', '/lists', { name: 'Readers' })).id;
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const c = await api('post', '/contacts', { email: `reader-${i}-${stamp}@example.test` });
    if (i < 2) await api('post', `/contacts/${c.id}/consent`, { channel: 'email', action: 'subscribed', source: 'form', lawfulBasis: 'consent', evidenceNote: 'Form' });
    ids.push(c.id);
  }
  await api('post', `/lists/${list}/members`, { contactIds: ids });
  const c = await api('post', '/campaigns', { name: 'Accessible campaign', channel: 'email', topicId });
  await api('patch', `/campaigns/${c.id}`, {
    expectedVersion: 1,
    audience: { include: [{ type: 'list', listId: list }], exclude: [] },
    sender: { senderIdentityId: null, fromName: 'Ada', replyTo: null },
    messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Hello', preheader: '', body: { format: 'text', text: 'Hi there' } } }],
  });
  draftId = c.id;
});
test.afterAll(async () => page.context().close());

test('campaign list and the create dialog have no WCAG A/AA violations', async () => {
  await page.goto('/campaigns');
  await expect(page.getByRole('table', { name: 'Campaigns' })).toBeVisible();
  await expectNoViolations(page, 'campaign list');
  await page.getByRole('button', { name: 'New campaign' }).click();
  await expect(page.getByRole('dialog', { name: 'New campaign' })).toBeVisible();
  await expectNoViolations(page, 'create dialog');
  await page.keyboard.press('Escape');
});

test('draft editor, review with the estimate, and the schedule dialog have no violations', async () => {
  await page.goto(`/campaigns/${draftId}`);
  await expect(page.getByLabel('Subject', { exact: true })).toBeVisible();
  await expectNoViolations(page, 'draft editor');
  await page.getByRole('button', { name: 'Run full check' }).click();
  await expect(page.getByText('Can receive it (estimate)')).toBeVisible();
  await expectNoViolations(page, 'review with estimate');
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Schedule this campaign' }).getByText('Can receive it (estimate)')).toBeVisible();
  await expectNoViolations(page, 'schedule dialog');
  await page.keyboard.press('Escape');
});

test('a sending campaign (live progress) and a finished one with history have no violations', async () => {
  const v = (await api('get', `/campaigns/${draftId}`)).version;
  const s = await api('post', `/campaigns/${draftId}/schedule`, { mode: 'at', sendAt: new Date(Date.now() + 86_400_000).toISOString(), expectedVersion: v });
  await withOwnerConnection(async (cl) => {
    await cl.query(`UPDATE campaign_executions SET status = 'delivering', started_at = now(), materialized_at = now(), planned = 2, sent = 1, skipped = 1, skipped_by_reason = '{"CONSENT_MISSING": 1}' WHERE id = $1`, [s.currentExecution.id]);
    await cl.query(`UPDATE campaigns SET status = 'sending' WHERE id = $1`, [draftId]);
  });
  await page.goto(`/campaigns/${draftId}`);
  await expect(page.getByRole('progressbar', { name: 'Sent' })).toBeVisible();
  await expectNoViolations(page, 'sending campaign');
  await page.getByRole('button', { name: 'Cancel campaign' }).click();
  await expect(page.getByRole('dialog', { name: 'Cancel this campaign?' })).toBeVisible();
  await expectNoViolations(page, 'cancel dialog');
  await page.getByRole('dialog', { name: 'Cancel this campaign?' }).getByRole('button', { name: 'Cancel campaign' }).click();
  await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
  await page.getByRole('table', { name: 'Versions' }).getByRole('button', { name: 'View' }).click();
  await expect(page.getByRole('dialog', { name: 'Version #1' })).toBeVisible();
  await expectNoViolations(page, 'version dialog');
});

test('campaign dialogs are keyboard-safe: Escape closes, focus returns to the trigger', async () => {
  await page.goto('/campaigns');
  const trigger = page.getByRole('button', { name: 'New campaign' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New campaign' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Campaign name')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('SMS and WhatsApp draft editors have no violations; the text and the preview are keyboard- and screen-reader-reachable', async () => {
  const topicId = (await api('get', '/topics')).data.find((t: { key: string }) => t.key === 'marketing').id;
  const sms = await api('post', '/campaigns', { name: 'Accessible SMS', channel: 'sms', topicId });
  await page.goto(`/campaigns/${sms.id}`);
  const text = page.getByLabel('Text message');
  await expect(text).toBeVisible();
  await text.focus();
  await page.keyboard.type('Hi {{ contact.first_name | "there" }}, sale today');
  // The preview is a polite live region and shows exactly what is sent (STOP instruction included).
  const preview = page.locator('[aria-live="polite"]').filter({ hasText: 'What the example contact receives' });
  await expect(preview).toContainText('Reply STOP to opt out.');
  await expect(page.getByLabel('Subject', { exact: true })).toHaveCount(0); // no email fields on an SMS campaign
  await expectNoViolations(page, 'SMS draft editor');

  const wa = await api('post', '/campaigns', { name: 'Accessible WhatsApp', channel: 'whatsapp', topicId });
  await page.goto(`/campaigns/${wa.id}`);
  await expect(page.getByLabel('Template name')).toBeVisible();
  await page.getByLabel('Template name').fill('spring_sale');
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await expect(page.getByLabel('Parameter {{1}}')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove parameter 1' })).toBeVisible();
  await expectNoViolations(page, 'WhatsApp draft editor');
});
