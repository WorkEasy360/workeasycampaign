import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { linkFromMail } from './mailbox';

/**
 * Phase 5 accessibility: automated WCAG 2.1 A/AA checks (axe-core) on every audience screen with real data, plus the
 * keyboard behaviour axe cannot see (skip link, dialog focus containment, Escape, focus return).
 */
const PASSWORD = 'maple-river-lantern-42';
const stamp = Date.now().toString(36);
const user = { name: 'Alex Access', email: `a11y-${stamp}@example.test` };

test.describe.configure({ mode: 'serial' });

let page: Page;
let contactPath = '';
let importPath = '';

async function csrf(p: Page) {
  return (await p.context().cookies()).find((c) => c.name.endsWith('wk_csrf'))!.value;
}

/** Audits the current page (after data-driven content settles) and returns its violations, one line each. */
async function violations(p: Page): Promise<string[]> {
  await expect(p.getByText(/^Loading/)).toHaveCount(0);
  await expect(p.getByText(/^Checking/)).toHaveCount(0);
  const result = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
}

async function expectNoViolations(p: Page, label: string) {
  expect(await violations(p), `${label} accessibility violations`).toEqual([]);
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
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel('Organization name').fill('Accessible Co');
  await page.getByLabel('Workspace name').fill('Main');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  // Realistic content on every screen: a contact with consent, a list, a tag, a field, a suppression and an import.
  const ws = ((await (await page.request.get('/api/v1/me/context')).json()) as { workspace: { id: string } }).workspace.id;
  const api = async (method: 'post' | 'put', path: string, data: unknown) => {
    const r = await page.request[method](`/api/v1/workspaces/${ws}${path}`, { data, headers: { 'x-csrf-token': await csrf(page) } });
    expect(r.ok(), `${method} ${path}: ${r.status()}`).toBe(true);
    return r.json();
  };
  const c = await api('post', '/contacts', { firstName: 'Ada', lastName: 'Lovelace', email: `ada-${stamp}@example.test`, company: 'Engines' });
  contactPath = `/contacts/${c.id}`;
  await api('post', `/contacts/${c.id}/consent`, { channel: 'email', action: 'subscribed', lawfulBasis: 'consent', source: 'paper', evidenceNote: 'Signed form' });
  await api('post', '/lists', { name: 'Newsletter' });
  await api('post', '/tags', { name: 'VIP', color: 'violet' });
  await api('post', '/custom-fields', { key: 'city', label: 'City', type: 'text' });
  await api('post', '/suppressions', { channel: 'sms', reason: 'manual', identityKind: 'phone', value: '+14155550190' });
  await page.goto('/imports');
  await page.locator('#csv-file').setInputFiles({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from(`Email,First name\nimport-${stamp}@example.test,Grace\n`) });
  await expect(page).toHaveURL(/\/imports\/[0-9a-f-]{36}$/);
  importPath = new URL(page.url()).pathname;
});

test.afterAll(async () => {
  await page.context().close();
});

test('every audience list screen has no WCAG A/AA violations', async () => {
  const found: Record<string, string[]> = {};
  for (const [label, path] of [
    ['contacts list', '/contacts'],
    ['lists', '/audience/lists'],
    ['tags', '/audience/tags'],
    ['topics', '/audience/topics'],
    ['custom fields', '/audience/fields'],
    ['do not contact', '/audience/suppressions'],
    ['consent settings', '/audience/consent'],
    ['imports', '/imports'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const v = await violations(page);
    if (v.length) found[label] = v;
  }
  expect(found).toEqual({});
});

test('contact detail has no WCAG A/AA violations', async () => {
  await page.goto(contactPath);
  await expect(page.getByRole('heading', { name: 'Ada Lovelace' })).toBeVisible();
  await expect(page.getByText(/Eligible|Not eligible/).first()).toBeVisible();
  await expectNoViolations(page, 'contact detail');
});

test('import mapping and dry-run screens have no WCAG A/AA violations', async () => {
  await page.goto(importPath);
  await expect(page.getByLabel('Import Email as')).toBeVisible();
  await expectNoViolations(page, 'import mapping');
  await page.getByRole('button', { name: 'Check file' }).click();
  await expect(page.getByText('Will create')).toBeVisible();
  await expectNoViolations(page, 'import dry run');
});

test('dialogs are keyboard-safe: the page behind is unreachable, Escape closes, focus returns to the trigger', async () => {
  await page.goto('/audience/lists');
  const trigger = page.getByRole('button', { name: 'New list' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New list' });
  await expect(dialog).toBeVisible();
  await expectNoViolations(page, 'new list dialog');
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    // The page behind a modal <dialog> is inert: focus may leave for the browser UI (activeElement = body) but must
    // never land on page content outside the dialog.
    const ok = await dialog.evaluate((d) => !document.activeElement || document.activeElement === document.body || d.contains(document.activeElement));
    expect(ok, `focus reached page content outside the dialog after ${i + 1} Tab presses`).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('a skip link leads keyboard users past the navigation', async () => {
  await page.goto('/contacts');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/);
});
