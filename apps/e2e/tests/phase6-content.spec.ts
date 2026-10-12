import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { linkFromMail } from './mailbox';

/**
 * Content amendment end to end (docs/contracts/phase-6-content-amendment.md): designed emails (blocks, merge fields,
 * live preview), templates (create, apply, save as), preview as a real contact, sending a designed email in test mode
 * (version v2), the recipient list (row 23), and WCAG 2.1 A/AA on every new screen. Serial: later steps reuse data.
 */
const PASSWORD = 'maple-river-lantern-42';
const stamp = Date.now().toString(36);
const user = { name: 'Cora Content', email: `content-${stamp}@example.test` };

test.describe.configure({ mode: 'serial' });
let page: Page;
let ws = '';
let campaignId = '';
let annId = '';

/**
 * App screens are scanned WITHOUT the documents inside sandboxed email-preview frames: those frames forbid scripts by
 * design (axe cannot run inside them and the scan stalls), and their content is the email, not app UI. The frames
 * themselves are asserted to carry an accessible title, and the rendered email HTML gets its own scan (C2).
 */
async function violations(p: Page): Promise<string[]> {
  await expect(p.getByText(/^Loading/)).toHaveCount(0);
  for (const frame of await p.locator('iframe[sandbox]').all()) expect(await frame.getAttribute('title')).toBeTruthy();
  const result = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).exclude('iframe[sandbox]').analyze();
  return result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
}
const expectNoViolations = async (p: Page, label: string) => expect(await violations(p), `${label} accessibility violations`).toEqual([]);
const csrf = async () => (await page.context().cookies()).find((c) => c.name.endsWith('wk_csrf'))!.value;
async function api(method: 'get' | 'post' | 'patch', path: string, data?: unknown) {
  const r = await page.request[method](`/api/v1/workspaces/${ws}${path}`, method === 'get' ? {} : { data: data ?? {}, headers: { 'x-csrf-token': await csrf() } });
  return { status: r.status(), body: (await r.json().catch(() => null)) as any };
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
  await page.getByLabel('Organization name').fill('Content Co');
  await page.getByLabel('Workspace name').fill('Main');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  ws = ((await (await page.request.get('/api/v1/me/context')).json()) as { workspace: { id: string } }).workspace.id;
  const topicId = (await api('get', '/topics')).body.data.find((t: { key: string }) => t.key === 'marketing').id;
  const list = (await api('post', '/lists', { name: 'Readers' })).body.id;
  const people = [
    { email: `ann-${stamp}@example.test`, firstName: 'Ann', consent: true },
    { email: `ben-${stamp}@example.test`, consent: true },
    { email: `cy-${stamp}@example.test`, firstName: 'Cy', consent: false },
  ];
  const ids: string[] = [];
  for (const p of people) {
    const c = (await api('post', '/contacts', { email: p.email, ...(p.firstName ? { firstName: p.firstName } : {}) })).body;
    if (p.consent) await api('post', `/contacts/${c.id}/consent`, { channel: 'email', action: 'subscribed', source: 'form', lawfulBasis: 'consent', evidenceNote: 'Form' });
    ids.push(c.id);
  }
  annId = ids[0]!;
  await api('post', `/lists/${list}/members`, { contactIds: ids });
  const c = (await api('post', '/campaigns', { name: 'Autumn newsletter', channel: 'email', topicId })).body;
  await api('patch', `/campaigns/${c.id}`, {
    expectedVersion: 1,
    audience: { include: [{ type: 'list', listId: list }], exclude: [] },
    sender: { senderIdentityId: null, fromName: 'Cora', replyTo: null },
    messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Autumn news', preheader: '', body: { format: 'text', text: 'Hello.\n\nOur autumn range is here.' } } }],
  });
  campaignId = c.id;
});
test.afterAll(async () => page.context().close());

test('C1. switch a plain-text message to a designed email, add blocks with formatting and a personal field, save', async () => {
  await page.goto(`/campaigns/${campaignId}`);
  await page.getByRole('button', { name: 'Switch to a designed email' }).click();
  const blocks = page.getByRole('list', { name: 'Email blocks' });
  await expect(blocks.getByRole('listitem')).toHaveCount(2);
  await page.getByRole('button', { name: 'Add heading' }).click();
  await page.getByRole('button', { name: 'Move block 3 up' }).click();
  await page.getByRole('button', { name: 'Move block 2 up' }).click();
  await page.getByLabel('Heading text', { exact: true }).fill('Hi ');
  await page.getByLabel('Heading text', { exact: true }).press('End');
  await page.getByLabel('Insert personal field into Heading text').selectOption('contact.first_name');
  await expect(page.getByLabel('Heading text', { exact: true })).toHaveValue('Hi {{ contact.first_name | "there" }}');
  await page.getByRole('button', { name: 'Add button' }).click();
  await page.getByLabel('Button label', { exact: true }).fill('See the range');
  await page.getByLabel('Link', { exact: true }).fill('https://shop.example.com/autumn');
  await page.getByLabel('Text', { exact: true }).nth(1).fill('Our **autumn** range is [here](https://shop.example.com).');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('All changes saved')).toBeVisible();
  const saved = (await api('get', `/campaigns/${campaignId}`)).body.draft.messages[0].content;
  expect(saved.schema).toBe('email.content.v2');
  expect(saved.body.blocks.map((b: { type: string }) => b.type)).toEqual(['heading', 'paragraph', 'paragraph', 'button']);
  expect(saved.body.blocks[2].runs).toEqual([{ text: 'Our ' }, { text: 'autumn', bold: true }, { text: ' range is ' }, { text: 'here', href: 'https://shop.example.com' }, { text: '.' }]);
});

test('C2. the live preview shows the email as recipients get it (example contact), in a sandboxed frame', async () => {
  await page.getByRole('tab', { name: 'Preview' }).click();
  const frame = page.frameLocator('iframe[title="Email preview"]');
  await expect(frame.getByRole('heading', { name: 'Hi Alex' })).toBeVisible();
  await expect(frame.getByRole('link', { name: 'See the range' })).toHaveAttribute('href', 'https://shop.example.com/autumn');
  await expect(frame.getByText('Unsubscribe')).toBeVisible();
  expect(await page.locator('iframe[title="Email preview"]').getAttribute('sandbox')).toBe('');
  await page.getByRole('button', { name: 'Mobile' }).click();
  await expect(page.getByRole('button', { name: 'Mobile' })).toHaveAttribute('aria-pressed', 'true');
  await expectNoViolations(page, 'message preview');
  // The email itself, as a normal document: headings, link names, image alternatives, language, contrast.
  const html = (await page.locator('iframe[title="Email preview"]').getAttribute('srcdoc'))!;
  const emailPage = await page.context().newPage();
  await emailPage.setContent(html);
  const email = await new AxeBuilder({ page: emailPage }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(email.violations.map((v) => v.id), 'rendered email accessibility violations').toEqual([]);
  await emailPage.close();
  await page.getByRole('tab', { name: 'Edit' }).click();
  await expectNoViolations(page, 'block editor');
});

test('C3. an invalid link is a readiness finding that links to the field', async () => {
  await page.getByLabel('Link', { exact: true }).fill('javascript:alert(1)');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('All changes saved')).toBeVisible();
  const finding = page.getByRole('link', { name: /Use a full link starting with https/ });
  await expect(finding).toBeVisible();
  await finding.click();
  await expect(page.getByLabel('Link', { exact: true })).toBeFocused();
  await page.getByLabel('Link', { exact: true }).fill('https://shop.example.com/autumn');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('All changes saved')).toBeVisible();
  await expect(page.getByRole('link', { name: /Use a full link starting with https/ })).toHaveCount(0);
});

test('C4. preview as a real contact fills in their details', async () => {
  await page.getByRole('button', { name: 'Preview as a contact' }).click();
  const dialog = page.getByRole('dialog', { name: 'Preview as a contact' });
  await dialog.getByLabel('Find a contact').fill('ann-');
  await dialog.getByRole('button', { name: /^Preview as / }).first().click();
  await expect(dialog.frameLocator('iframe[title="Email preview"]').getByRole('heading', { name: 'Hi Ann' })).toBeVisible();
  await expectNoViolations(page, 'preview as a contact');
  await page.keyboard.press('Escape');
  const r = await api('post', `/campaigns/${campaignId}/preview`, { contactId: annId });
  expect(r.body.subject).toBe('Autumn news');
});

test('C5. save the email as a template; the templates screens list and open it', async () => {
  await page.getByRole('button', { name: 'Save as template' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save as template' });
  await dialog.getByLabel('Template name').fill('Seasonal newsletter');
  await dialog.getByRole('button', { name: 'Save template' }).click();
  await expect(dialog.getByText('Saved as “Seasonal newsletter”.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('link', { name: 'Templates' }).first().click();
  await expect(page).toHaveURL(/\/templates$/);
  await expect(page.getByRole('table', { name: 'Templates' }).getByRole('link', { name: 'Seasonal newsletter' })).toBeVisible();
  await expectNoViolations(page, 'templates list');
  await page.getByRole('link', { name: 'Seasonal newsletter' }).click();
  await expect(page.getByLabel('Heading text', { exact: true })).toHaveValue('Hi {{ contact.first_name | "there" }}');
  await expectNoViolations(page, 'template editor');
});

test('C6. a template created from scratch is applied to a new campaign (copy, not link)', async () => {
  await page.goto('/templates/new');
  await page.getByLabel('Name', { exact: true }).fill('Welcome');
  await page.getByLabel('Subject', { exact: true }).fill('Welcome aboard');
  await page.getByRole('button', { name: 'Add text' }).click();
  await page.getByLabel('Text', { exact: true }).fill('Glad you are here.');
  await page.getByRole('button', { name: 'Create template' }).click();
  await expect(page).toHaveURL(/\/templates\/[0-9a-f-]{36}$/);
  const topicId = (await api('get', '/topics')).body.data.find((t: { key: string }) => t.key === 'marketing').id;
  const c = (await api('post', '/campaigns', { name: 'From template', channel: 'email', topicId })).body;
  await page.goto(`/campaigns/${c.id}`);
  await page.getByRole('button', { name: 'Use a template' }).click();
  const dialog = page.getByRole('dialog', { name: 'Use a template' });
  await dialog.getByRole('button', { name: 'Use template Welcome' }).click();
  await expect(page.getByLabel('Subject', { exact: true })).toHaveValue('Welcome aboard');
  await expect(page.getByLabel('Text', { exact: true })).toHaveValue('Glad you are here.');
});

test('C7. a designed email sends in test mode: the version is v2 with merge_tags_v1; recipients are listed by name', async () => {
  await page.goto(`/campaigns/${campaignId}`);
  await page.getByRole('button', { name: 'Send now' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send this campaign now?' });
  await dialog.getByRole('button', { name: 'Send now' }).click();
  await expect(page.getByText(/^Finished — sent 2 of 2 planned/)).toBeVisible({ timeout: 30_000 });
  const versions = (await api('get', `/campaigns/${campaignId}/versions`)).body.data;
  const snapshot = (await api('get', `/campaigns/${campaignId}/versions/${versions[0].id}`)).body.snapshot;
  expect(snapshot.schema).toBe('campaign.version.v2');
  expect(snapshot.personalization).toEqual({ mode: 'merge_tags_v1' });
  const recipients = page.getByRole('table', { name: 'Recipients' });
  await expect(recipients.getByText('Ann')).toBeVisible();
  await expect(recipients.getByText('Skipped')).toBeVisible();
  await expect(recipients).not.toContainText('@example.test');
  await expectNoViolations(page, 'finished campaign with recipients');
});

test('C8. the dashboard shows measured campaign results only; engagement is stated as not tracked', async () => {
  await page.goto('/dashboard');
  const card = page.getByRole('region', { name: 'Campaign results' });
  await expect(page.getByRole('heading', { name: 'Campaign results' })).toBeVisible();
  const analytics = (await api('get', '/campaigns/analytics')).body;
  expect(analytics.pipeline.sent).toBeGreaterThanOrEqual(2);
  for (const m of Object.values(analytics.engagement)) expect(m).toEqual({ available: false, reason: 'tracking_not_enabled' });
  await expect(card.getByText('Sent', { exact: true })).toBeVisible();
  await expect(card.getByText(analytics.pipeline.sent.toLocaleString('en-US'), { exact: true }).first()).toBeVisible();
  await expect(card.getByText(/not tracked yet/)).toBeVisible();
  await expectNoViolations(page, 'dashboard with campaign results');
});
