/**
 * Architecture boundaries (docs/architecture.md §Boundaries). Run: pnpm lint:boundaries (part of pnpm check / CI).
 * Paths are resolved files, so workspace packages appear as packages/<name>/... and npm packages as node_modules/...
 */
const SERVER_ONLY_NPM = 'node_modules/(@prisma|prisma|pg|ioredis|bullmq|argon2|nodemailer|@nestjs|fastify|@fastify)/';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'web-no-server-packages',
      severity: 'error',
      comment: 'The browser app talks to the API over HTTP only. It must never reach the database, workers or channels.',
      from: { path: '^apps/web/' },
      to: { path: '^(packages/(db|channels)|apps/(api|worker))/' },
    },
    {
      name: 'web-no-server-libraries',
      severity: 'error',
      comment: 'Database drivers, Redis, password hashing and server frameworks are server-only.',
      from: { path: '^apps/web/' },
      to: { path: SERVER_ONLY_NPM },
    },
    {
      name: 'web-no-undeclared-or-unresolvable',
      severity: 'error',
      comment: 'apps/web may only import packages it declares (a server driver would show up here first).',
      from: { path: '^apps/web/' },
      to: { couldNotResolve: true },
    },
    {
      name: 'shared-is-contracts-only',
      severity: 'error',
      comment: 'packages/shared ships to the browser: contracts only, no server packages or policy.',
      from: { path: '^packages/shared/' },
      to: { path: `^(packages/(db|channels)|apps/)|${SERVER_ONLY_NPM}` },
    },
    {
      name: 'generated-prisma-client-is-private',
      severity: 'error',
      comment: 'Only packages/db may touch the generated client; everyone else gets context-bound transactions.',
      from: { pathNot: '^packages/db/' },
      to: { path: '^packages/db/src/generated/' },
    },
    {
      name: 'identity-store-only-in-local-provider',
      severity: 'error',
      comment: 'The identity schema belongs to the local identity provider and nothing else.',
      from: { pathNot: '^(apps/api/src/modules/identity/infrastructure/local/|packages/db/)' },
      // Second alternative catches the bare specifier when the package has not been built yet.
      to: { path: '^(packages/db/(src|dist)/identity\\.|@workeasy/db/identity$)' },
    },
    {
      name: 'db-testing-only-in-tests',
      severity: 'error',
      comment: 'Owner connections and database resets exist for tests only.',
      from: { pathNot: '(\\.test\\.tsx?$|/test/|/tests/|^packages/db/(scripts|src)/)' },
      to: { path: '^(packages/db/(src|dist)/testing\\.|@workeasy/db/testing$)' },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment: 'Domain code holds rules only: no HTTP, persistence or framework imports.',
      from: { path: '^apps/api/src/modules/[^/]+/domain/' },
      to: { path: `(/(infrastructure|http)/|^packages/db/|${SERVER_ONLY_NPM})` },
    },
    {
      name: 'api-and-worker-are-separate',
      severity: 'error',
      comment: 'The API and the worker share code through packages, never by importing each other.',
      from: { path: '^apps/(api|worker)/' },
      to: { path: '^apps/(api|worker)/', pathNot: '^apps/$1/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: '(node_modules|/dist/|/generated/)' },
    // dist/ and generated/ stay in the graph as dependency TARGETS (rules watch them) but are not traversed.
    exclude: { path: '(^|/)(\\.next|coverage)/' },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.d.ts'],
    },
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
  },
};
