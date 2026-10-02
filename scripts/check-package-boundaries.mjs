#!/usr/bin/env node
/**
 * Manifest-level boundary check: fails if a browser-shipped package DECLARES a server-only dependency, even before
 * any import exists. Complements dependency-cruiser, which checks actual imports.
 */
import { readFileSync } from 'node:fs';

const FORBIDDEN = {
  'apps/web': [
    '@workeasy/db', '@workeasy/channels', '@workeasy/api', '@workeasy/worker',
    '@prisma/client', '@prisma/adapter-pg', 'prisma', 'pg', 'ioredis', 'redis', 'bullmq', 'argon2', 'nodemailer',
  ],
  'packages/shared': [
    '@workeasy/db', '@workeasy/channels', '@prisma/client', 'pg', 'ioredis', 'bullmq', 'argon2', 'nodemailer',
  ],
};

let failed = false;
for (const [dir, forbidden] of Object.entries(FORBIDDEN)) {
  const pkg = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8'));
  const declared = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
  for (const name of forbidden) {
    if (name in declared) {
      console.error(`✗ ${dir}/package.json must not depend on ${name}`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log('✓ package manifests respect boundaries');
