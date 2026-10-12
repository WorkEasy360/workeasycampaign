import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisRateLimitStore } from '../src/common/rate-limit.js';
import { ShutdownState } from '../src/health/health.controller.js';
import { Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp } from './support.js';

const TOKEN = 'metrics-token-0123456789abcdef';

/**
 * Health and metrics (Phase 7.12): readiness reports its dependency checks and drains on shutdown; /metrics exists only
 * with a token, refuses a wrong one, exposes the operational series, and never carries ids or personal data.
 */
describe('observability', () => {
  let t: TestApp;
  let owner: Agent;
  const metrics = (app: TestApp, auth?: string) =>
    (app.app.getHttpAdapter().getInstance() as { inject: (o: object) => Promise<{ statusCode: number; body: string; headers: Record<string, string> }> }).inject({
      method: 'GET',
      url: '/metrics',
      headers: auth ? { authorization: auth } : {},
    });

  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test', METRICS_TOKEN: TOKEN, JOB_QUEUE: 'postgres' });
    owner = await signUp(t, undefined, 'Owner');
  });
  afterAll(async () => t?.close());

  it('liveness never touches dependencies; readiness lists its checks', async () => {
    expect((await new Agent(t).get('/health')).body).toEqual({ status: 'ok' });
    const r = await new Agent(t).get('/health/ready');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ready', checks: { database: { status: 'ok' }, jobQueue: { status: 'ok' } } });
  });

  it('readiness turns 503 while draining (before shutdown completes)', async () => {
    const other = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    try {
      expect((await new Agent(other).get('/health/ready')).status).toBe(200);
      other.app.get(ShutdownState).beforeApplicationShutdown();
      expect((await new Agent(other).get('/health/ready')).status).toBe(503);
      expect((await new Agent(other).get('/health')).status).toBe(200);
    } finally {
      await other.close();
    }
  });

  it('/metrics needs the token; without a configured token it does not exist', async () => {
    expect((await metrics(t)).statusCode).toBe(401);
    expect((await metrics(t, 'Bearer wrong-token-0123456789abcdef')).statusCode).toBe(401);
    expect((await metrics(t, TOKEN)).statusCode).toBe(401); // the scheme is required
    const ok = await metrics(t, `Bearer ${TOKEN}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toMatch(/^text\/plain/);
    const plain = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    try {
      expect((await metrics(plain, `Bearer ${TOKEN}`)).statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });

  it('exposes request, job, queue and dependency series by route template — no ids, no personal data', async () => {
    const { workspaceId } = await createOrg(owner, 'Metrics Co');
    // A query string that would be personal data if it leaked (the request may be refused; only its route matters).
    await owner.get(`/v1/workspaces/${workspaceId}/campaigns?search=${encodeURIComponent('secret.person@example.com')}`);
    await owner.get(`/v1/workspaces/${workspaceId}/campaigns`);
    const body = (await metrics(t, `Bearer ${TOKEN}`)).body;
    for (const series of [
      'workeasy_http_requests_total',
      'workeasy_http_request_duration_seconds_bucket',
      'workeasy_database_ping_seconds',
      'workeasy_job_queue_jobs',
      'workeasy_campaign_scheduler_lag_seconds',
      'workeasy_webhook_events_total',
    ]) {
      expect(body, series).toContain(series);
    }
    expect(body).toMatch(/workeasy_http_requests_total\{method="GET",route="\/v1\/workspaces\/:workspaceId\/campaigns",status="2xx"\} \d+/);
    expect(body).not.toContain(workspaceId);
    expect(body).not.toMatch(/example\.com|secret\.person|search=/);
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(body).not.toContain(TOKEN);
  });

  it('the shared rate-limit store (Redis) down: readiness 503 naming it, limited routes 503 + Retry-After (fail closed), metric -1', async () => {
    // Nothing listens on port 1: an unreachable Redis, without needing a Redis server.
    const down = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test', METRICS_TOKEN: TOKEN }, { rateLimitStore: new RedisRateLimitStore('redis://127.0.0.1:1') });
    try {
      const ready = await new Agent(down).get('/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body.error.fields).toEqual({ rateLimitStore: ['unavailable'] });
      const login = await new Agent(down).post('/v1/auth/login', { email: 'a@b.test', password: 'whatever-password-1' });
      expect(login.status).toBe(503);
      expect(login.body.error.code).toBe('service_unavailable');
      expect(Number(login.headers['retry-after'])).toBeGreaterThan(0);
      // Routes without a limit keep working (liveness, and anything not rate-limited).
      expect((await new Agent(down).get('/health')).status).toBe(200);
      expect((await metrics(down, `Bearer ${TOKEN}`)).body).toMatch(/^workeasy_redis_ping_seconds -1$/m);
    } finally {
      await down.close();
    }
  });
});
