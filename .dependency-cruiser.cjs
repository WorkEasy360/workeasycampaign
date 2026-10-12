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
      to: { path: '^(packages/(db|channels|audience-core|audience-infra)|apps/(api|worker))/' },
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
      to: { path: `^(packages/(db|channels|audience-core|audience-infra)|apps/)|${SERVER_ONLY_NPM}` },
    },
    // ─── Email content (docs/contracts/phase-6-content-amendment.md §4) ───
    {
      name: 'content-is-pure',
      severity: 'error',
      comment: 'packages/content renders email for the browser preview and the API alike: shared only. No server package, Audience internals, app code or Node built-ins.',
      from: { path: '^packages/content/' },
      to: { path: `^(packages/(db|channels|audience-core|audience-infra)|apps)/|${SERVER_ONLY_NPM}` },
    },
    {
      name: 'content-no-builtins',
      severity: 'error',
      comment: 'Rendering is pure: no Node built-ins (it runs in the browser too).',
      from: { path: '^packages/content/src/', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['core'] },
    },
    // ─── Audience read side (docs/contracts/phase-5-audience.md §9.8, architecture §4; milestone 6.2) ───
    {
      name: 'audience-core-is-pure',
      severity: 'error',
      comment: 'audience-core holds pure rules and ports: shared and Node built-ins only. No database, framework, channel or app code.',
      from: { path: '^packages/audience-core/' },
      to: { path: `^(packages/(db|channels|audience-infra)|apps)/|${SERVER_ONLY_NPM}` },
    },
    {
      name: 'audience-core-no-io-builtins',
      severity: 'error',
      comment: 'Production audience-core code may use node:crypto only (fingerprint, hashes) — no filesystem, network or process I/O.',
      from: { path: '^packages/audience-core/src/', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['core'], pathNot: '^(node:)?crypto$' },
    },
    {
      name: 'audience-infra-boundaries',
      severity: 'error',
      comment: 'audience-infra adapters use audience-core, @workeasy/db (never the Prisma client directly) and shared — no apps, frameworks or channels.',
      from: { path: '^packages/audience-infra/' },
      to: { path: '^(packages/channels|apps)/|node_modules/(@prisma|prisma|pg|ioredis|bullmq|argon2|nodemailer|@nestjs|fastify|@fastify)/' },
    },
    {
      name: 'audience-packages-no-undeclared-or-unresolvable',
      severity: 'error',
      comment: 'The Audience read packages may import only what they declare (an undeclared framework or driver shows up here first).',
      from: { path: '^packages/audience-(core|infra)/' },
      to: { couldNotResolve: true },
    },
    {
      name: 'lower-packages-not-audience',
      severity: 'error',
      comment: 'shared, db and channels sit below the Audience read packages (strict layering, no cycles).',
      from: { path: '^packages/(shared|db|channels)/' },
      to: { path: '^packages/audience-(core|infra)/' },
    },
    {
      name: 'audience-infra-only-in-composition-roots',
      severity: 'error',
      comment:
        'Adapters are wired only by the Audience module (its own context) and the worker composition root; Campaigns and worker jobs receive audience-core ports.',
      from: { path: '^apps/', pathNot: '^(apps/api/src/modules/audience/|apps/worker/src/audience-read-side\\.ts$|apps/(api|worker)/test/)' },
      to: { path: '^packages/audience-infra/' },
    },
    {
      name: 'campaigns-no-audience-internals',
      severity: 'error',
      comment: 'Campaigns read Audience data only through audience-core ports — never the Audience module, its services or its tables.',
      from: { path: '^apps/api/src/modules/campaigns/' },
      to: { path: '^(apps/api/src/modules/audience/|packages/audience-infra/)' },
    },
    {
      name: 'null-delivery-port-only-in-factory-and-tests',
      severity: 'error',
      comment: 'Contract §9.3: the test-only NullDeliveryPort may be imported only by the campaigns module factory and by tests.',
      from: { path: '^(apps|packages)/', pathNot: '^apps/api/(src/modules/campaigns/campaigns\\.module\\.ts$|test/)' },
      to: { path: '^apps/api/src/modules/campaigns/infrastructure/null-delivery-port\\.ts$' },
    },
    {
      name: 'audience-not-campaigns',
      severity: 'error',
      comment: 'Dependencies point from Campaigns to Audience ports, never back (events flow out through the outbox).',
      from: { path: '^(apps/api/src/modules/audience/|packages/audience-(core|infra)/)' },
      to: { path: '^apps/api/src/modules/campaigns/' },
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
      comment: 'Owner connections and database resets exist for tests only (unit/API suites and the E2E harness).',
      from: { pathNot: '(\\.test\\.tsx?$|/test/|/tests/|^packages/db/(scripts|src)/|^apps/e2e/)' },
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
