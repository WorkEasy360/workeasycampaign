import { withOwnerConnection } from '@workeasy/db/testing';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { linkFromMail } from './mailbox';

/**
 * Phase 6 — campaigns, end to end through the real web app, API (CAMPAIGN_DELIVERY_MODE=test: the NullDeliveryPort
 * accepts messages, nothing leaves the system) and test database. Serial: later flows reuse earlier data.
 *
 * Fixtures seeded through the owner database connection (documented, deterministic):
 *  - a RUNNING execution for pause / resume / failure (a real send to a tiny audience completes in < 1 s, so clicking
 *    "Pause" mid-run would be timing-dependent);
 *  - degraded audience resolution: the count bitmap invalidated and list_memberships held under a table lock, so the
 *    exact audience query cannot finish within its budget (as in the API tests).
 */
const PASSWORD = 'maple-river-lantern-42';
const stamp = Date.now().toString(36);
const owner = { name: 'Olga Owner', email: `camp-owner-${stamp}@example.test` };
const viewer = { name: 'Vera Viewer', email: `camp-viewer-${stamp}@example.test` };
const outsider = { name: 'Otto Outsider', email: `camp-out-${stamp}@example.test` };

test.describe.configure({ mode: 'serial' });

let page: Page;
let ws = '';
let customersList = '';
let noConsentList = '';
let topicId = '';
let campaignA = '';
let campaignDraftE = '';

async function registerAndVerify(p: Page, who: { name: string; email: string }) {
  await p.goto('/register');
  await p.getByLabel('Your name').fill(who.name);
  await p.getByLabel('Work email').fill(who.email);
  await p.getByLabel('Password').fill(PASSWORD);
  await p.getByRole('button', { name: 'Create account' }).click();
  await expect(p.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
  await p.goto(await linkFromMail(who.email, 'verify_email'));
  await expect(p.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
}

async function signIn(p: Page, email: string) {
  await p.goto('/login');
  await p.getByLabel('Work email').fill(email);
  await p.getByLabel('Password').fill(PASSWORD);
  await p.getByRole('button', { name: 'Sign in' }).click();
  await expect(p).not.toHaveURL(/\/login/);
}

const newPage = async (browser: Browser) => (await browser.newContext()).newPage();
const csrf = async (p: Page) => (await p.context().cookies()).find((c) => c.name.endsWith('wk_csrf'))!.value;
async function api<T = any>(p: Page, method: 'get' | 'post' | 'patch' | 'delete', path: string, data?: unknown): Promise<{ status: number; body: T }> {
  const r = await p.request[method](`/api/v1/workspaces/${ws}${path}`, method === 'get' ? {} : { data: data ?? {}, headers: { 'x-csrf-token': await csrf(p) } });
  return { status: r.status(), body: (await r.json().catch(() => null)) as T };
}
const content = (subject: string) => ({ schema: 'email.content.v1', subject, preheader: '', body: { format: 'text', text: 'Hello from the E2E suite.' } });

/** A ready draft through the API (the UI flows below cover creating and editing through the UI). */
async function readyCampaign(name: string, list = customersList, topic = topicId) {
  const c = await api(page, 'post', '/campaigns', { name, channel: 'email', topicId: topic });
  expect(c.status).toBe(201);
  const p = await api(page, 'patch', `/campaigns/${c.body.id}`, {
    expectedVersion: 1,
    audience: { include: [{ type: 'list', listId: list }], exclude: [] },
    sender: { senderIdentityId: null, fromName: 'Olga at Acme', replyTo: null },
    messages: [{ variantKey: 'default', content: content(`${name} subject`) }],
  });
  expect(p.status).toBe(200);
  return { id: c.body.id as string, version: p.body.version as number };
}

/** A scheduled campaign whose execution is made "running" (delivering) by the owner connection — see header. */
async function runningCampaign(name: string, topic = topicId) {
  const c = await readyCampaign(name, customersList, topic);
  const s = await api(page, 'post', `/campaigns/${c.id}/schedule`, { mode: 'at', sendAt: new Date(Date.now() + 86_400_000).toISOString(), expectedVersion: c.version });
  expect(s.status).toBe(200);
  await withOwnerConnection(async (cl) => {
    await cl.query(`UPDATE campaign_executions SET status = 'delivering', started_at = now(), materialized_at = now(), planned = 3, sent = 1, last_progress_at = now() WHERE id = $1`, [s.body.currentExecution.id]);
    await cl.query(`UPDATE campaigns SET status = 'sending' WHERE id = $1`, [c.id]);
  });
  return c.id;
}

test.beforeAll(async ({ browser }) => {
  page = await newPage(browser);
});
test.afterAll(async () => {
  await page.context().close();
});

test('setup: owner, workspace, and contacts with and without consent', async () => {
  await registerAndVerify(page, owner);
  await signIn(page, owner.email);
  await page.getByLabel('Organization name').fill('Campaign Co');
  await page.getByLabel('Workspace name').fill('Main');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  ws = ((await (await page.request.get('/api/v1/me/context')).json()) as { workspace: { id: string } }).workspace.id;
  topicId = (await api(page, 'get', '/topics')).body.data.find((t: { key: string }) => t.key === 'marketing').id;
  customersList = (await api(page, 'post', '/lists', { name: 'Customers' })).body.id;
  noConsentList = (await api(page, 'post', '/lists', { name: 'Prospects without consent' })).body.id;
  const customers: string[] = [];
  for (let i = 0; i < 5; i++) {
    const c = await api(page, 'post', '/contacts', { email: `cust-${i}-${stamp}@example.test`, firstName: `Customer${i}` });
    expect(c.status).toBe(201);
    if (i < 4) {
      const consent = await api(page, 'post', `/contacts/${c.body.id}/consent`, { channel: 'email', action: 'subscribed', source: 'form', lawfulBasis: 'consent', evidenceNote: 'Website form' });
      expect(consent.status).toBeLessThan(300);
    }
    customers.push(c.body.id);
  }
  expect((await api(page, 'post', `/lists/${customersList}/members`, { contactIds: customers })).status).toBe(200);
  const prospects: string[] = [];
  for (let i = 0; i < 2; i++) prospects.push((await api(page, 'post', '/contacts', { email: `pros-${i}-${stamp}@example.test` })).body.id);
  expect((await api(page, 'post', `/lists/${noConsentList}/members`, { contactIds: prospects })).status).toBe(200);
});

test('1. create a campaign', async () => {
  await page.getByRole('link', { name: 'Campaigns' }).click();
  await expect(page).toHaveURL(/\/campaigns$/);
  await expect(page.getByText('Test delivery mode')).toBeVisible();
  await page.getByRole('button', { name: 'New campaign' }).click();
  const dialog = page.getByRole('dialog', { name: 'New campaign' });
  await dialog.getByLabel('Campaign name').fill('Autumn launch');
  await dialog.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Autumn launch' })).toBeVisible();
  await expect(page.getByLabel('Topic')).toHaveValue(topicId); // default topic preselected
  campaignA = new URL(page.url()).pathname.split('/').pop()!;
});

test('2. edit the draft (explicit save, survives reload)', async () => {
  await page.getByLabel('From name (optional)').fill('Olga at Campaign Co');
  await page.getByLabel('Subject', { exact: true }).fill('Our autumn collection is here');
  // New campaigns start as designed emails (content amendment): the body is a text block.
  await page.getByRole('button', { name: 'Add text' }).click();
  await page.getByLabel('Text', { exact: true }).fill('Hello! Our autumn collection has arrived.');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('All changes saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Subject', { exact: true })).toHaveValue('Our autumn collection is here');
});

test('3. choose the audience', async () => {
  await page.getByLabel('Send to').selectOption({ label: 'List · Customers' });
  await expect(page.getByRole('list', { name: 'Send to: selected' })).toContainText('Customers');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('All changes saved')).toBeVisible();
});

test('4. pre-flight: audience size and eligibility estimate', async () => {
  await page.getByRole('button', { name: 'Run full check' }).click();
  const review = page.getByRole('complementary', { name: 'Review' });
  await expect(review.getByText('Can receive it (estimate)')).toBeVisible();
  await expect(review.getByText('≈ 4')).toBeVisible();
  await expect(review.getByText('No consent')).toBeVisible();
  await expect(review.getByText('Ready to schedule')).toBeVisible();
});

test('5. schedule for later', async () => {
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Schedule this campaign' });
  await expect(dialog.getByText('Can receive it (estimate)')).toBeVisible();
  const d = new Date(Date.now() + 2 * 86_400_000);
  const local = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T09:30`;
  await dialog.getByLabel('Date and time').fill(local);
  await dialog.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(page.getByText('Campaign scheduled')).toBeVisible();
  await expect(page.getByText('Scheduled', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/^Scheduled for /)).toBeVisible();
});

test('10. unschedule back to draft', async () => {
  await page.getByRole('button', { name: 'Unschedule' }).click();
  await page.getByRole('dialog', { name: 'Unschedule this campaign?' }).getByRole('button', { name: 'Unschedule' }).click();
  await expect(page.getByLabel('Subject', { exact: true })).toBeEnabled();
  await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();
});

test('12. restore a version into the draft', async () => {
  await page.getByLabel('Subject', { exact: true }).fill('A different subject');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('All changes saved')).toBeVisible();
  const history = page.getByRole('table', { name: 'Versions' });
  await history.getByRole('button', { name: 'Restore into draft' }).click();
  await page.getByRole('dialog', { name: 'Restore version #1 into the draft?' }).getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByLabel('Subject', { exact: true })).toHaveValue('Our autumn collection is here');
});

test('6, 13, 14. send now in test mode: progress then completion from server counts', async () => {
  await page.getByRole('button', { name: 'Send now' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send this campaign now?' });
  await expect(dialog.getByText('Can receive it (estimate)')).toBeVisible();
  await dialog.getByRole('button', { name: 'Send now' }).click();
  await expect(page.getByText('Sending started')).toBeVisible();
  await expect(page.getByText('Finished — sent 4 of 4 planned')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible();
  const run = page.getByRole('region', { name: /^Run #/ });
  await expect(run.getByText('Skipped because')).toBeVisible();
  await expect(run.getByText('No consent')).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Sent' })).toHaveAttribute('aria-valuenow', '4');
  // no editing after sending; the version history shows both runs' versions
  await expect(page.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Versions' }).getByRole('row')).toHaveCount(3);
});

test('7, 8. pause and resume a running campaign', async () => {
  const id = await runningCampaign('Running B');
  await page.goto(`/campaigns/${id}`);
  await expect(page.getByText('Sent 1 of 3 planned')).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('dialog', { name: 'Pause sending?' }).getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByText(/^Paused — sent 1 of 3 planned/)).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await page.getByRole('dialog', { name: 'Resume sending?' }).getByRole('button', { name: 'Resume' }).click();
  // the engine continues the same execution; with no recipients left it completes from its rows
  await expect(page.getByText(/^Finished — /)).toBeVisible({ timeout: 30_000 });
});

test('15, 11. failure on resume (topic archived while paused) is explained; return to draft', async () => {
  const topic = (await api(page, 'post', '/topics', { name: 'Flash sale', key: `flash_${stamp}` })).body.id as string;
  const id = await runningCampaign('Running C', topic);
  await page.goto(`/campaigns/${id}`);
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('dialog', { name: 'Pause sending?' }).getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByText(/^Paused — sent/)).toBeVisible();
  expect((await api(page, 'post', `/topics/${topic}/archive`)).status).toBe(200);
  await page.getByRole('button', { name: 'Resume' }).click();
  await page.getByRole('dialog', { name: 'Resume sending?' }).getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByText(/configuration problem/)).toBeVisible();
  await expect(page.getByText('Failed', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Return to draft' }).click();
  await page.getByRole('dialog', { name: 'Return to draft?' }).getByRole('button', { name: 'Return to draft' }).click();
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible();
});

test('9. cancel a scheduled campaign', async () => {
  const c = await readyCampaign('Cancel D');
  const s = await api(page, 'post', `/campaigns/${c.id}/schedule`, { mode: 'at', sendAt: new Date(Date.now() + 86_400_000).toISOString(), expectedVersion: c.version });
  expect(s.status).toBe(200);
  await page.goto(`/campaigns/${c.id}`);
  await page.getByRole('button', { name: 'Cancel campaign' }).click();
  await page.getByRole('dialog', { name: 'Cancel this campaign?' }).getByRole('button', { name: 'Cancel campaign' }).click();
  await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel campaign' })).toHaveCount(0);
});

test('19. no eligible recipients: the check says so and scheduling is refused with the reason', async () => {
  const c = await readyCampaign('Nobody F', noConsentList);
  await page.goto(`/campaigns/${c.id}`);
  await page.getByRole('button', { name: 'Run full check' }).click();
  await expect(page.getByText('No contact in this audience can currently receive this campaign').first()).toBeVisible();
  await expect(page.getByText(/problem blocks sending/)).toBeVisible();
  await page.getByRole('button', { name: 'Send now' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send this campaign now?' });
  await dialog.getByRole('button', { name: 'Send now' }).click();
  await expect(dialog.getByText('Fix these before scheduling')).toBeVisible();
  await expect(dialog.getByText('No contact in this audience can currently receive this campaign')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect((await api(page, 'get', `/campaigns/${c.id}/versions`)).body.data).toHaveLength(0);
});

test('20. degraded audience resolution: honest "temporarily unavailable"; sending refused as retryable, nothing scheduled', async () => {
  const c = await readyCampaign('Degraded G');
  await page.goto(`/campaigns/${c.id}`);
  await expect(page.getByLabel('Subject', { exact: true })).toBeVisible();
  let release: () => Promise<void> = async () => undefined;
  try {
    await withOwnerConnection((cl) => cl.query(`UPDATE audience_count_state SET state = 'invalid', generation = generation + 1, reason = 'e2e' WHERE workspace_id = $1`, [ws]));
    let unlock!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((r) => (locked = r));
    const done = withOwnerConnection(async (cl) => {
      await cl.query('BEGIN');
      await cl.query('LOCK TABLE list_memberships IN ACCESS EXCLUSIVE MODE');
      locked();
      await new Promise<void>((r) => (unlock = r));
      await cl.query('ROLLBACK');
    });
    await held;
    release = async () => {
      unlock();
      await done;
    };
    await page.getByRole('button', { name: 'Run full check' }).click();
    await expect(page.getByText('Eligibility estimate temporarily unavailable')).toBeVisible();
    await expect(page.getByText(/Audience resolution recovery has been requested/)).toBeVisible();
    await expect(page.getByText(/≈/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Send now' }).click();
    const dialog = page.getByRole('dialog', { name: 'Send this campaign now?' });
    await dialog.getByRole('button', { name: 'Send now' }).click();
    await expect(dialog.getByText('The audience is being prepared')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  } finally {
    await release();
  }
  const versions = await api(page, 'get', `/campaigns/${c.id}/versions`);
  expect(versions.body.data).toHaveLength(0);
});

test('18. concurrent edits: the second save is told the campaign changed, and keeps its text', async ({ browser }) => {
  const c = await readyCampaign('Shared E');
  campaignDraftE = c.id;
  const other = await newPage(browser);
  await signIn(other, owner.email);
  await page.goto(`/campaigns/${c.id}`);
  await other.goto(`/campaigns/${c.id}`);
  await page.getByLabel('Subject', { exact: true }).fill('First editor');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('All changes saved')).toBeVisible();
  await other.getByLabel('Subject', { exact: true }).fill('Second editor');
  await other.getByRole('button', { name: 'Save draft' }).click();
  await expect(other.getByText('Changed by someone else')).toBeVisible();
  await expect(other.getByLabel('Subject', { exact: true })).toHaveValue('Second editor');
  await other.context().close();
});

test('17. a viewer can read campaigns but cannot change or send them (UI hidden, API denied)', async ({ browser }) => {
  await page.goto('/settings/members');
  await page.getByRole('button', { name: 'Invite people' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email address').fill(viewer.email);
  await dialog.getByLabel('Role in Main').selectOption({ label: 'Viewer' });
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('table', { name: 'Invitations' })).toContainText(viewer.email);
  const vp = await newPage(browser);
  await registerAndVerify(vp, viewer);
  await signIn(vp, viewer.email);
  await vp.goto(await linkFromMail(viewer.email, 'invitation'));
  await vp.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(vp).toHaveURL(/\/dashboard/);
  await vp.goto('/campaigns');
  await expect(vp.getByRole('table', { name: 'Campaigns' })).toContainText('Autumn launch');
  await expect(vp.getByRole('button', { name: 'New campaign' })).toHaveCount(0);
  await vp.goto(`/campaigns/${campaignDraftE}`);
  await expect(vp.getByLabel('Subject', { exact: true })).toBeDisabled();
  await expect(vp.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
  // send controls stay visible but disabled, with the server's reason in plain words (architecture §6)
  await expect(vp.getByRole('button', { name: 'Send now' })).toBeDisabled();
  await expect(vp.getByRole('button', { name: 'Send now' })).toHaveAccessibleDescription('Your role in this workspace can’t do this.');
  const token = (await vp.context().cookies()).find((c) => c.name.endsWith('wk_csrf'))!.value;
  const send = await vp.request.post(`/api/v1/workspaces/${ws}/campaigns/${campaignDraftE}/schedule`, { data: { mode: 'now', expectedVersion: 2 }, headers: { 'x-csrf-token': token } });
  expect(send.status()).toBe(403);
  const edit = await vp.request.patch(`/api/v1/workspaces/${ws}/campaigns/${campaignDraftE}`, { data: { expectedVersion: 2, name: 'Hacked' }, headers: { 'x-csrf-token': token } });
  expect(edit.status()).toBe(403);
  await vp.context().close();
});

test('16. another organization cannot see or touch these campaigns', async ({ browser }) => {
  const op = await newPage(browser);
  await registerAndVerify(op, outsider);
  await signIn(op, outsider.email);
  await op.getByLabel('Organization name').fill('Other Co');
  await op.getByLabel('Workspace name').fill('Theirs');
  await op.getByRole('button', { name: 'Create organization' }).click();
  await expect(op).toHaveURL(/\/dashboard/);
  await op.goto(`/campaigns/${campaignA}`);
  await expect(op.getByText('This campaign is not available')).toBeVisible();
  await op.goto('/campaigns');
  await expect(op.getByText('No campaigns yet')).toBeVisible();
  const theirWs = ((await (await op.request.get('/api/v1/me/context')).json()) as { workspace: { id: string } }).workspace.id;
  expect((await op.request.get(`/api/v1/workspaces/${ws}/campaigns/${campaignA}`)).status()).toBe(404);
  expect((await op.request.get(`/api/v1/workspaces/${theirWs}/campaigns/${campaignA}`)).status()).toBe(404);
  const token = (await op.context().cookies()).find((c) => c.name.endsWith('wk_csrf'))!.value;
  expect((await op.request.post(`/api/v1/workspaces/${ws}/campaigns/${campaignA}/cancel`, { data: { expectedVersion: 1 }, headers: { 'x-csrf-token': token } })).status()).toBe(404);
  await op.context().close();
});
