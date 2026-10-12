import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { jobLogEntry } from '../src/common/observability.js';
import { type Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp } from './support.js';

/**
 * Structured operational logs: one access entry per request and one entry per background job, built from
 * allowlists — route template (never the URL or query), ids, status, duration, outcome; never personal data.
 */
describe('observability: structured access and job logs without personal data', () => {
  let t: TestApp;
  let owner: Agent;
  let W: string;
  let orgId: string;
  const lines: string[] = [];

  beforeAll(async () => {
    await resetTestDatabase();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(function (this: unknown, message: unknown) {
      if (typeof message === 'string') lines.push(message);
    });
    t = await startTestApp({ CAMPAIGN_DELIVERY_MODE: 'test' });
    owner = await signUp(t, undefined, 'Owner');
    ({ orgId, workspaceId: W } = await createOrg(owner, 'Logs Co'));
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await t?.close();
  });

  const entries = (kind: string) => lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).filter((e) => e.msg === kind);

  it('logs the route template, ids, status, duration and outcome — not the query (which may hold an e-mail)', async () => {
    const r = await owner.get(`/v1/workspaces/${W}/contacts?q=${encodeURIComponent('ann.secret@example.test')}`);
    expect(r.status).toBe(200);
    const e = entries('http').find((x) => x.requestId === r.headers['x-request-id']);
    expect(e).toMatchObject({ method: 'GET', route: '/v1/workspaces/:workspaceId/contacts', status: 200, outcome: 'ok', orgId, workspaceId: W });
    expect(typeof e.durationMs).toBe('number');
    expect(e.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines.join('\n')).not.toContain('ann.secret');
  });

  it('client errors are classified', async () => {
    const r = await owner.get(`/v1/workspaces/${W}/campaigns/not-a-uuid`);
    const e = entries('http').find((x) => x.requestId === r.headers['x-request-id']);
    expect(e).toMatchObject({ status: r.status, outcome: 'client_error' });
  });

  it('job entries carry only allowlisted ids from the envelope', () => {
    const env = {
      correlationId: '01a11850-b308-7102-9271-54fa8ea2c893',
      tenant: { orgId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222' },
      actor: { type: 'user', id: 'u', email: 'boss@example.test', displayName: 'The Boss' },
      payload: { executionId: '33333333-3333-4333-8333-333333333333', email: 'x@example.test', note: 'secret' },
    };
    const e = jobLogEntry('campaign.run', env, 'ok', 12.6);
    expect(e).toEqual({
      msg: 'job',
      job: 'campaign.run',
      outcome: 'ok',
      durationMs: 13,
      correlationId: env.correlationId,
      orgId: env.tenant.orgId,
      workspaceId: env.tenant.workspaceId,
      ids: { executionId: env.payload.executionId },
    });
    expect(JSON.stringify(e)).not.toMatch(/example\.test|Boss|secret/);
  });
});
