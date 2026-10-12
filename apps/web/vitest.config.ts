import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    // CI (2026-10-10, measured in a 3.5 GB / 8-CPU Linux container): one jsdom worker per CPU ran out of memory and CPU
    // (PSI memory "full" stalls), and render-heavy tests then crossed the 5 s timeout — 7 of 124 in one run. Two workers
    // passed every run. Locally the default (one per CPU) is kept.
    ...(process.env.CI ? { maxWorkers: 2 } : {}),
  },
});
