import { type Browser, expect, type Page, test } from '@playwright/test';
import { linkFromMail } from './mailbox';

const PASSWORD = 'maple-river-lantern-42';
const stamp = Date.now().toString(36);
const owner = { name: 'Olivia Owner', email: `owner-${stamp}@example.test` };
const teammate = { name: 'Theo Teammate', email: `teammate-${stamp}@example.test` };

test.describe.configure({ mode: 'serial' });

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

async function signIn(page: Page, email: string, next?: string) {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function newPage(browser: Browser) {
  return (await browser.newContext()).newPage();
}

test('signed-out visitors are sent to sign in, keeping where they wanted to go', async ({ page }) => {
  await page.goto('/settings/members');
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fmembers/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('new user: register → verify → create organization → first workspace → dashboard', async ({ page }) => {
  await registerAndVerify(page, owner);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await signIn(page, owner.email);
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel('Organization name').fill('Acme Marketing');
  await page.getByLabel('Workspace name').fill('India');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole('heading', { name: 'Welcome, Olivia' })).toBeVisible();
  await expect(page.getByText('You are working in')).toContainText('India');
});

test('owner invites a teammate who joins with viewer access to one workspace', async ({ page, browser }) => {
  await signIn(page, owner.email);
  await expect(page).toHaveURL(/\/dashboard/);
  await page.goto('/settings/members');
  await page.getByRole('button', { name: 'Invite people' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email address').fill(teammate.email);
  await dialog.getByLabel('Role in India').selectOption({ label: 'Viewer' });
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('table', { name: 'Invitations' })).toContainText(teammate.email);

  const tp = await newPage(browser);
  await registerAndVerify(tp, teammate);
  await signIn(tp, teammate.email);
  await expect(tp).toHaveURL(/\/onboarding/); // no organization of their own yet
  await tp.goto(await linkFromMail(teammate.email, 'invitation'));
  await expect(tp.getByRole('heading', { name: 'Join Acme Marketing' })).toBeVisible();
  await tp.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(tp).toHaveURL(/\/dashboard/);
  await expect(tp.getByText('You are working in')).toContainText('India');

  // Viewer sees members but cannot invite; admin-only tabs are hidden.
  await tp.goto('/settings/members');
  await expect(tp.getByRole('table', { name: 'Organization members' })).toContainText(owner.email);
  await expect(tp.getByRole('button', { name: 'Invite people' })).toHaveCount(0);
  await expect(tp.getByRole('link', { name: 'Audit log' })).toHaveCount(0);

  // The server enforces it too: a direct API call is refused.
  const orgs = await tp.request.get('/api/v1/organizations');
  const orgId = (await orgs.json()).data[0].id;
  const denied = await tp.request.get(`/api/v1/organizations/${orgId}/audit-logs`);
  expect(denied.status()).toBe(403);
  await tp.context().close();
});

test('removing a member ends their access immediately', async ({ page, browser }) => {
  const tp = await newPage(browser);
  await signIn(tp, teammate.email);
  await expect(tp).toHaveURL(/\/dashboard/);

  await signIn(page, owner.email);
  await page.goto('/settings/members');
  await page.getByRole('button', { name: `Remove ${teammate.name}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove member' }).click();
  await expect(page.getByRole('table', { name: 'Organization members' })).not.toContainText(teammate.email);

  await tp.goto('/dashboard');
  await expect(tp).toHaveURL(/\/onboarding/);
  await tp.context().close();
});

test('audit log records what happened and denied attempts', async ({ page }) => {
  await signIn(page, owner.email);
  await page.goto('/settings/audit');
  const table = page.getByRole('table', { name: 'Audit log' });
  await expect(table).toContainText('Organization created');
  await expect(table).toContainText('Invitation accepted');
  await expect(table).toContainText('Member removed');
  await page.getByLabel('Filter activity').selectOption({ label: 'Denied access' });
  await expect(table).toContainText('Access denied');
});

test('a revoked session cannot be used again', async ({ page, browser }) => {
  const other = await newPage(browser);
  await signIn(other, owner.email);
  await expect(other).toHaveURL(/\/dashboard/);

  await signIn(page, owner.email);
  await page.goto('/settings/security');
  await page.getByRole('button', { name: 'Sign out all other sessions' }).click();
  await expect(page.getByText(/session\(s\) signed out/)).toBeVisible();

  await other.goto('/settings');
  await expect(other).toHaveURL(/\/login/);
  await other.context().close();
});

test('signing out returns to the sign-in page', async ({ page }) => {
  await signIn(page, owner.email);
  await expect(page).toHaveURL(/\/dashboard/);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login/);
});
