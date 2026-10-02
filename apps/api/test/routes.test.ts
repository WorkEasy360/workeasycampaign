import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTES } from '../src/openapi/routes.js';
import { Agent, startTestApp, type TestApp } from './support.js';

let t: TestApp;
let registered: { method: string; url: string }[];
const SAMPLE_ID = '00000000-0000-4000-8000-000000000000';
const toOpenApi = (url: string) => url.replace(/:(\w+)/g, '{$1}');
const toConcrete = (path: string) => path.replace(/\{\w+\}/g, SAMPLE_ID);

beforeAll(async () => {
  t = await startTestApp();
  const fastify = t.app.getHttpAdapter().getInstance() as unknown as { workeasyRoutes: { method: string; url: string }[] };
  registered = fastify.workeasyRoutes.filter((r) => r.url !== '*' && !r.url.endsWith('*'));
});
afterAll(async () => t?.close());

describe('route inventory', () => {
  it('every registered route is documented in OpenAPI, and every documented route exists', () => {
    const actual = registered.map((r) => `${r.method} ${toOpenApi(r.url)}`).sort();
    const documented = ROUTES.map((r) => `${r.method} ${r.path}`).sort();
    expect(actual).toEqual(documented);
  });

  it('every non-public route rejects anonymous callers with 401 (so every route has an access policy)', async () => {
    const anonymous = new Agent(t);
    await anonymous.get('/v1/auth/csrf');
    for (const route of ROUTES.filter((r) => r.access !== 'public')) {
      const res = await anonymous.request(route.method, toConcrete(route.path), route.method === 'GET' ? undefined : {});
      expect(res.status, `${route.method} ${route.path}`).toBe(401);
    }
  });

  it('public routes are reachable without a session (never blocked by a missing policy)', async () => {
    const anonymous = new Agent(t);
    for (const route of ROUTES.filter((r) => r.access === 'public' && r.method === 'GET')) {
      const res = await anonymous.get(toConcrete(route.path));
      expect(res.status, route.path).toBe(200);
    }
  });

  it('serves the OpenAPI document', async () => {
    const res = await new Agent(t).get('/v1/openapi.json');
    expect(res.body.openapi).toBe('3.1.0');
    expect(Object.keys(res.body.paths)).toContain('/v1/organizations/{orgId}/members');
  });
});
