import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { testDatabaseUrls } from '@workeasy/db/testing';

/**
 * End-to-end: real API + production web build + test database. Dedicated ports so a running dev stack is untouched.
 * Email is captured by the API's file mailer in MAIL_DIR; tests read links from there.
 */
export const WEB_URL = 'http://localhost:3100';
const API_PORT = 4100;
export const MAIL_DIR = resolve(import.meta.dirname, '.mail');
const urls = testDatabaseUrls();
const repo = resolve(import.meta.dirname, '../..');

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  globalSetup: './global-setup.ts',
  use: { baseURL: WEB_URL, trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  webServer: [
    {
      command: 'node apps/api/dist/main.js',
      cwd: repo,
      port: API_PORT,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        PORT: String(API_PORT),
        DATABASE_URL: urls.app,
        IDENTITY_DATABASE_URL: urls.identity,
        SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e-secret',
        APP_URL: WEB_URL,
        // The Next.js server on this machine is the only proxy in front of the API.
        TRUST_PROXY: 'loopback',
        MAIL_TRANSPORT: 'file',
        MAIL_FILE_DIR: MAIL_DIR,
        DATA_FINGERPRINT_SECRET: 'e2e-fingerprint-e2e-fingerprint-e2e-fp',
        // Uploaded CSVs stay out of the (synced) repository.
        FILE_STORE_DIR: join(tmpdir(), 'workeasy-e2e-files'),
      },
    },
    {
      command: 'pnpm --filter @workeasy/web exec next build && pnpm --filter @workeasy/web exec next start --port 3100',
      cwd: repo,
      url: `${WEB_URL}/login`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: { API_URL: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
