import { type Browser, expect, type Page, test } from '@playwright/test';
import { linkFromMail } from './mailbox';

/**
 * Phase 5 — contacts and audience, end to end through the real web app, API and database.
 * Serial: later tests build on the workspace, contact, list and tag created earlier.
 */
const PASSWORD = 'maple-river-lantern-42';
const stamp = Date.now().toString(36);
const owner = { name: 'Aditi Admin', email: `aud-owner-${stamp}@example.test` };
const viewer = { name: 'Vik Viewer', email: `aud-viewer-${stamp}@example.test` };
const contactEmail = `priya-${stamp}@example.test`;

test.describe.configure({ mode: 'serial' });

let contactUrl = '';

// One signed-in owner session shared by the serial tests: signing in before every test would trip the API's
// per-IP login rate limit (20/min), which is working as intended.
let page: Page;
test.beforeAll(async ({ browser }) => {
  page = await newPage(browser);
});
test.afterAll(async () => {
  await page.context().close();
});

async function registerAndVerify(page: Page, who: { name: string; email: string }) {
  await page.goto('/register');
  await page.getByLabel('Your name').fill(who.name);
  await page.getByLabel('Work email').fill(who.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
  await page.goto(await linkFromMail(who.email, 'verify_email'));
  await expect(page.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
}

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function newPage(browser: Browser) {
  return (await browser.newContext()).newPage();
}

async function context(page: Page) {
  const r = await page.request.get('/api/v1/me/context');
  return (await r.json()) as { organization: { id: string }; workspace: { id: string; name: string } };
}

test('setup: an owner with an organization and workspace', async () => {
  await registerAndVerify(page, owner);
  await signIn(page, owner.email);
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel('Organization name').fill('Audience Co');
  await page.getByLabel('Workspace name').fill('India');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});

test('1. create a contact', async () => {
  await page.getByRole('link', { name: 'Audience' }).click();
  await expect(page).toHaveURL(/\/contacts/);
  await page.getByRole('button', { name: 'New contact' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('First name').fill('Priya');
  await dialog.getByLabel('Last name').fill('Sharma');
  await dialog.getByLabel('Email').fill(`  ${contactEmail.toUpperCase()} `);
  await dialog.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Priya Sharma' })).toBeVisible();
  // Shown as entered (trimmed); matching uses the normalized lower-case key — the import test below relies on it.
  await expect(page.getByText(contactEmail.toUpperCase(), { exact: true })).toBeVisible();
  contactUrl = new URL(page.url()).pathname;
});

test('2. edit a contact', async () => {
  await page.goto(contactUrl);
  await page.getByLabel('Company').fill('Sharma Textiles');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Contact saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Company')).toHaveValue('Sharma Textiles');
  await page.goto('/contacts');
  await expect(page.getByRole('table', { name: 'Contacts' })).toContainText('Priya Sharma');
});

test('3. create a list and add the contact', async () => {
  await page.goto('/audience/lists');
  await page.getByRole('button', { name: 'New list' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Newsletter');
  await page.getByRole('dialog').getByRole('button', { name: 'Create list' }).click();
  await expect(page.getByRole('table', { name: 'Lists' })).toContainText('Newsletter');

  await page.goto(contactUrl);
  await page.getByLabel('Add to list').selectOption({ label: 'Newsletter' });
  await page.getByRole('button', { name: 'Add to selected list' }).click();
  await expect(page.getByRole('button', { name: 'Remove from Newsletter' })).toBeVisible();

  await page.goto('/audience/lists');
  await expect(page.getByRole('row', { name: /Newsletter/ })).toContainText('1');
  await page.getByRole('link', { name: 'Newsletter' }).click();
  await expect(page.getByRole('table', { name: 'Contacts' })).toContainText('Priya Sharma');
});

test('4. tag the contact', async () => {
  await page.goto('/audience/tags');
  await page.getByRole('button', { name: 'Create a tag' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('VIP');
  await page.getByRole('dialog').getByRole('button', { name: 'Create tag' }).click();
  await expect(page.getByRole('link', { name: 'VIP' })).toBeVisible();

  await page.goto(contactUrl);
  await page.getByLabel('Add tag').selectOption({ label: 'VIP' });
  await page.getByRole('button', { name: 'Add selected tag' }).click();
  await expect(page.getByRole('button', { name: 'Remove tag VIP' })).toBeVisible();
  // The timeline is built from the domain events of the changes above.
  await expect(page.getByText('Contact tagged', { exact: true })).toBeVisible();
});

test('5. subscribe the contact to a topic', async () => {
  await page.goto('/audience/topics');
  // Every workspace starts with a default Marketing topic.
  await expect(page.getByRole('listitem').filter({ hasText: 'Marketing' }).getByText('Default', { exact: true })).toBeVisible();

  await page.goto(contactUrl);
  const topic = page.getByRole('listitem').filter({ hasText: 'Marketing' }).filter({ has: page.getByRole('button') });
  await topic.getByRole('button', { name: 'Subscribe' }).click();
  await expect(topic.getByRole('button', { name: 'Subscribed' })).toHaveAttribute('aria-pressed', 'true');
});

test('6. record consent with evidence, then the contact becomes eligible', async () => {
  await page.goto(contactUrl);
  await expect(page.getByText('CONSENT_MISSING', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Record change' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Record Email consent' });
  await dialog.getByLabel('Evidence').fill('Signed sheet, Mumbai expo');
  await dialog.getByLabel('Reference (optional)').fill('EXPO-42');
  await dialog.getByRole('button', { name: 'Record' }).click();
  // The toast and the new timeline entry share this text.
  await expect(page.getByText('Consent recorded', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/“Signed sheet, Mumbai expo” · ref EXPO-42/)).toBeVisible();
  await expect(page.getByText('Eligible', { exact: true })).toBeVisible();
});

test('7 + 8. suppress the contact, and eligibility turns false with the reason', async () => {
  await page.goto(contactUrl);
  await page.getByRole('button', { name: 'Suppress', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add to do-not-contact' });
  await dialog.getByLabel('Channel').selectOption('email');
  await dialog.getByLabel('Note (optional)').fill('Asked by phone');
  await dialog.getByRole('button', { name: 'Suppress' }).click();
  await expect(page.getByText('Added to the do-not-contact list')).toBeVisible();

  await expect(page.getByText('Not eligible', { exact: true })).toBeVisible();
  await expect(page.getByText('SUPPRESSED', { exact: true })).toBeVisible();
  // Consent is still granted: suppression is a separate concept and overrides it.
  await expect(page.getByText('CONSENT_MISSING', { exact: true })).toHaveCount(0);

  // The API gives the same structured answer.
  const ws = (await context(page)).workspace.id;
  const id = contactUrl.split('/').at(-1);
  const r = await page.request.post(`/api/v1/workspaces/${ws}/eligibility/check`, {
    data: { contactIds: [id], channel: 'email' },
    headers: { 'x-csrf-token': (await page.context().cookies()).find((c) => c.name.endsWith('wk_csrf'))!.value },
  });
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body.results[0].eligible).toBe(false);
  expect(body.results[0].reasons.map((x: { code: string }) => x.code)).toEqual(['SUPPRESSED']);

  await page.goto('/audience/suppressions');
  await expect(page.getByRole('table', { name: 'Suppressions' })).toContainText('Priya Sharma');
});

test('9 + 10. import a CSV: map, dry run, duplicates handled deterministically, then import', async () => {
  await page.goto('/imports');
  const csv = [
    'Email,First name,Company',
    `${contactEmail},Priya,Updated Co`, // existing contact → update
    `new1-${stamp}@example.test,Neha,`, // create
    `NEW1-${stamp}@example.test,Neha again,`, // same email, different case → duplicate in file, skipped
    'not-an-email,Bad,', // no valid identity → error
    `new2-${stamp}@example.test,=HYPERLINK("x"),`, // formula text is stored as text, never executed
  ].join('\n');
  await page.locator('#csv-file').setInputFiles({ name: 'leads.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page).toHaveURL(/\/imports\/[0-9a-f-]{36}$/);
  await expect(page.getByLabel('Import Email as')).toHaveValue('email');
  await expect(page.getByLabel('Import First name as')).toHaveValue('first_name');

  await page.getByRole('button', { name: 'Check file' }).click();
  const counts = (label: string) => page.locator('dl > div').filter({ hasText: label }).locator('dd');
  await expect(counts('Will create')).toHaveText('2');
  await expect(counts('Will update')).toHaveText('1');
  await expect(counts('Will skip')).toHaveText('1');
  await expect(counts('Errors')).toHaveText('1');
  await expect(page.getByRole('table', { name: 'Import problems' })).toContainText('An earlier row in this file has the same email or phone');

  await page.getByRole('button', { name: 'Import 3 contacts' }).click();
  await expect(page.getByText('Completed', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(counts('Created')).toHaveText('2');
  await expect(counts('Updated')).toHaveText('1');

  await page.goto('/contacts');
  await expect(page.getByRole('table', { name: 'Contacts' })).toContainText(`new1-${stamp}@example.test`);
  await page.goto(contactUrl);
  await expect(page.getByLabel('Company')).toHaveValue('Updated Co');
});

test('11. a second workspace is isolated', async () => {
  const india = await context(page);
  const priyaId = contactUrl.split('/').at(-1);

  await page.goto('/workspaces');
  await page.getByRole('button', { name: 'New workspace' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Europe');
  await page.getByRole('dialog').getByRole('button', { name: /create/i }).click();
  await page.getByRole('row', { name: /Europe/ }).getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto('/contacts');
  await expect(page.getByText('Priya Sharma')).toHaveCount(0);
  await expect(page.getByText('No contacts yet')).toBeVisible();

  const europe = await context(page);
  expect(europe.workspace.id).not.toBe(india.workspace.id);
  // The India contact id does not exist from Europe's point of view (IDOR attempt).
  const r = await page.request.get(`/api/v1/workspaces/${europe.workspace.id}/contacts/${priyaId}`);
  expect(r.status()).toBe(404);
  await page.goto(`/contacts/${priyaId}`);
  await expect(page.getByText('Contact not available')).toBeVisible();

  // Switch back for the remaining tests.
  await page.goto('/workspaces');
  await page.getByRole('row', { name: /India/ }).getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});

test('12. a viewer can read contacts but cannot change them (UI hidden, API denied)', async ({ browser }) => {
  await page.goto('/settings/members');
  await page.getByRole('button', { name: 'Invite people' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email address').fill(viewer.email);
  await dialog.getByLabel('Role in India').selectOption({ label: 'Viewer' });
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('table', { name: 'Invitations' })).toContainText(viewer.email);

  const vp = await newPage(browser);
  await registerAndVerify(vp, viewer);
  await signIn(vp, viewer.email);
  await vp.goto(await linkFromMail(viewer.email, 'invitation'));
  await vp.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(vp).toHaveURL(/\/dashboard/);

  await vp.goto('/contacts');
  await expect(vp.getByRole('table', { name: 'Contacts' })).toContainText('Priya Sharma');
  await expect(vp.getByRole('button', { name: 'New contact' })).toHaveCount(0);
  await expect(vp.getByRole('link', { name: 'Imports' })).toHaveCount(0);
  await vp.getByRole('link', { name: 'Priya Sharma' }).click();
  await expect(vp.getByRole('heading', { name: 'Priya Sharma' })).toBeVisible();
  await expect(vp.getByLabel('First name')).toBeDisabled();
  await expect(vp.getByRole('button', { name: 'Record change' })).toHaveCount(0);
  await expect(vp.getByRole('button', { name: 'Erase personal data' })).toHaveCount(0);

  const ws = (await context(vp)).workspace.id;
  const csrf = (await vp.context().cookies()).find((c) => c.name.endsWith('wk_csrf'))!.value;
  const create = await vp.request.post(`/api/v1/workspaces/${ws}/contacts`, { data: { email: `sneaky-${stamp}@example.test` }, headers: { 'x-csrf-token': csrf } });
  expect(create.status()).toBe(403);
  const upload = await vp.request.post(`/api/v1/workspaces/${ws}/imports`, { data: 'Email\nx@example.test\n', headers: { 'x-csrf-token': csrf, 'content-type': 'text/csv' } });
  expect(upload.status()).toBe(403);
  await vp.context().close();
});

test('large uploads pass through the web proxy intact; oversize ones get a clean 413', async () => {
  const ws = (await context(page)).workspace.id;
  const csrf = (await page.context().cookies()).find((c) => c.name.endsWith('wk_csrf'))!.value;
  // About 15 MB but under 100,000 rows: must arrive byte-for-byte (the web proxy used to truncate at 10 MB).
  const rows = 95_000;
  const lines = ['Email,First name,Company'];
  for (let i = 0; i < rows; i++) lines.push(`bulk-${i}-${stamp}@example.test,Name${i},${'Company name padding '.repeat(5)}${i}`);
  const big = Buffer.from(lines.join('\n'));
  expect(big.length).toBeGreaterThan(12 * 1024 * 1024);
  const ok = await page.request.post(`/api/v1/workspaces/${ws}/imports?fileName=big.csv`, {
    data: big,
    headers: { 'x-csrf-token': csrf, 'content-type': 'text/csv' },
    timeout: 120_000,
  });
  expect(ok.status()).toBe(201);
  const stored = await ok.json();
  expect(stored.fileSize).toBe(big.length);
  expect(stored.totalRows).toBe(rows);
  await page.request.post(`/api/v1/workspaces/${ws}/imports/${stored.id}/cancel`, { headers: { 'x-csrf-token': csrf } });

  // 21 MB: just over the API limit. 40 MB: over the web proxy's own buffer limit too (it truncates at 32 MB) — must
  // still be a clean 413, never a hang or a partial import (hardening H-3).
  for (const mb of [21, 40]) {
    const r = await page.request.post(`/api/v1/workspaces/${ws}/imports?fileName=huge.csv`, {
      data: Buffer.alloc(mb * 1024 * 1024, 'a'),
      headers: { 'x-csrf-token': csrf, 'content-type': 'text/csv' },
      timeout: 120_000,
    });
    expect(r.status(), `${mb} MB`).toBe(413);
    expect((await r.json()).error.fields.file).toEqual(['FILE_TOO_LARGE']);
  }
});
