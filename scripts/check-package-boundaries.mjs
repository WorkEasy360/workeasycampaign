#!/usr/bin/env node
/**
 * Manifest-level boundary check: fails if a browser-shipped package DECLARES a server-only dependency, even before
 * any import exists. Complements dependency-cruiser, which checks actual imports.
 */
import { readFileSync } from 'node:fs';

const SERVER_DRIVERS = ['@prisma/client', '@prisma/adapter-pg', 'prisma', 'pg', 'ioredis', 'redis', 'bullmq', 'argon2', 'nodemailer'];
const FRAMEWORKS = ['@nestjs/common', '@nestjs/core', '@nestjs/config', '@nestjs/platform-fastify', 'fastify'];
const AUDIENCE_READ = ['@workeasy/audience-core', '@workeasy/audience-infra'];

const FORBIDDEN = {
  'apps/web': [
    '@workeasy/db', '@workeasy/channels', '@workeasy/api', '@workeasy/worker', ...AUDIENCE_READ,
    ...SERVER_DRIVERS,
  ],
  'packages/shared': [
    '@workeasy/db', '@workeasy/channels', ...AUDIENCE_READ, '@prisma/client', 'pg', 'ioredis', 'bullmq', 'argon2', 'nodemailer',
  ],
  // Audience read side (docs/contracts/phase-5-audience.md §9.8): core is pure; infra reaches the database only via @workeasy/db.
  'packages/audience-core': ['@workeasy/db', '@workeasy/channels', '@workeasy/audience-infra', ...SERVER_DRIVERS, ...FRAMEWORKS],
  'packages/audience-infra': ['@workeasy/channels', '@workeasy/api', '@workeasy/worker', ...SERVER_DRIVERS, ...FRAMEWORKS],
  // Email rendering (docs/contracts/phase-6-content-amendment.md §4): pure and browser-shipped (web preview).
  'packages/content': ['@workeasy/db', '@workeasy/channels', '@workeasy/api', '@workeasy/worker', ...AUDIENCE_READ, ...SERVER_DRIVERS, ...FRAMEWORKS],
  'packages/db': AUDIENCE_READ,
  'packages/channels': AUDIENCE_READ,
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
