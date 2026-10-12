import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { consentFingerprint, EligibilityEvaluator } from '@workeasy/audience-core';
import { TenantScopeMismatchError } from '@workeasy/audience-infra';
import type { Database } from '@workeasy/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE, ELIGIBILITY_EVALUATOR } from '../src/infrastructure/providers.js';
import { hmac } from '../src/infrastructure/tokens.js';
import { EligibilityService } from '../src/modules/audience/application/suppression-eligibility.service.js';
import { type Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp, withOwnerConnection } from './support.js';

/**
 * Milestone 6.2 — the Audience read side behind @workeasy/audience-core ports and @workeasy/audience-infra adapters.
 * Phase 5 behaviour is covered by the unchanged Phase 5 suites; this file proves the boundary itself.
 */
const SECRET = 'boundary-test-fingerprint-secret';
let t: TestApp;
let owner: Agent;
let other: Agent;
let W: string;
let orgId: string;
let W2: string;
const url = (p: string) => `/v1/workspaces/${W}${p}`;

async function newContact(agent: Agent, ws: string, body: Record<string, unknown>) {
  const r = await agent.post(`/v1/workspaces/${ws}/contacts`, body);
  if (r.status !== 201) throw new Error(`create contact failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string };
}

beforeAll(async () => {
  await resetTestDatabase();
  t = await startTestApp({ DATA_FINGERPRINT_SECRET: SECRET });
  owner = await signUp(t, undefined, 'Owner');
  const org = await createOrg(owner, 'Boundary Co');
  W = org.workspaceId;
  orgId = org.orgId;
  other = await signUp(t, undefined, 'Other');
  W2 = (await createOrg(other, 'Other Co')).workspaceId;
});
afterAll(async () => t?.close());

describe('fingerprint moved with an identical algorithm', () => {
  it('stored subject_fingerprint values (written by the consent API) equal the core function and the pre-move algorithm', async () => {
    const c = await newContact(owner, W, { email: ' Finger.Print@Example.COM ' });
    const r = await owner.post(url(`/contacts/${c.id}/consent`), { channel: 'email', action: 'subscribed', source: 'paper', lawfulBasis: 'consent', evidenceNote: 'Signed form' });
    expect(r.status).toBe(201);
    const stored = await withOwnerConnection(async (cl) => ({
      state: (await cl.query('SELECT subject_fingerprint FROM consent_states WHERE contact_id = $1', [c.id])).rows[0].subject_fingerprint as string,
      event: (await cl.query('SELECT subject_fingerprint FROM consent_events WHERE contact_id = $1', [c.id])).rows[0].subject_fingerprint as string,
    }));
    const expected = consentFingerprint(SECRET, 'email', 'finger.print@example.com');
    expect(stored).toEqual({ state: expected, event: expected });
    expect(expected).toBe(hmac(SECRET, 'consent-subject', 'email', 'finger.print@example.com'));
  });
});

describe('composition: Audience read side is injected as a core port', () => {
  it('the API binds ELIGIBILITY_EVALUATOR to the core EligibilityEvaluator', () => {
    expect(t.app.get(ELIGIBILITY_EVALUATOR, { strict: false })).toBeInstanceOf(EligibilityEvaluator);
  });

  it('HTTP eligibility/check and a direct port call give the same answer (EligibilityService delegates)', async () => {
    const yes = await newContact(owner, W, { email: 'yes@example.test' });
    await owner.post(url(`/contacts/${yes.id}/consent`), { channel: 'email', action: 'subscribed', source: 'paper', lawfulBasis: 'consent', evidenceNote: 'Signed form' });
    const no = await newContact(owner, W, { email: 'no@example.test' });
    const foreign = await newContact(other, W2, { email: 'yes@example.test' });
    const body = { contactIds: [yes.id, no.id, foreign.id], channel: 'email' as const, purpose: 'marketing' as const };

    const http = await owner.post(url('/eligibility/check'), body);
    expect(http.status).toBe(200);
    const db = t.app.get<Database>(DATABASE, { strict: false });
    const evaluator = t.app.get<EligibilityEvaluator<never>>(ELIGIBILITY_EVALUATOR, { strict: false });
    const direct = await db.withTenant({ orgId, workspaceId: W, userId: null }, (tx) => evaluator.evaluate({ tx: tx as never, orgId, workspaceId: W }, body));
    expect(http.body).toEqual(JSON.parse(JSON.stringify(direct)));
    expect(http.body.notFound).toEqual([foreign.id]);
    expect(Object.fromEntries(http.body.results.map((x: { contactId: string; reasons: { code: string }[] }) => [x.contactId, x.reasons.map((r) => r.code)]))).toEqual({
      [yes.id]: [],
      [no.id]: ['CONSENT_MISSING'],
    });
  });

  it('an unknown topic is still the Phase 5 validation error (400 validation_failed, field topicId)', async () => {
    const c = await newContact(owner, W, { email: 'topic@example.test' });
    const r = await owner.post(url('/eligibility/check'), { contactIds: [c.id], channel: 'email', topicId: '00000000-0000-4000-8000-000000000000' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_failed');
    expect(r.body.error.fields).toEqual({ topicId: ['No such topic in this workspace'] });
  });

  it('EligibilityService.evaluate refuses a workspace id that is not the transaction tenant', async () => {
    const service = t.app.get(EligibilityService, { strict: false });
    const db = t.app.get<Database>(DATABASE, { strict: false });
    await expect(
      db.withTenant({ orgId, workspaceId: W, userId: null }, (tx) => service.evaluate(tx, W2, { contactIds: [], channel: 'email', purpose: 'marketing' })),
    ).rejects.toBeInstanceOf(TenantScopeMismatchError);
  });
});

describe('architecture: Campaigns never reach Audience persistence', () => {
  const root = new URL('../src/modules/campaigns/', import.meta.url);
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  const sources = files(root.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  /** Prisma delegates of Audience-owned tables (docs/contracts/phase-5-audience.md §9.8). */
  const AUDIENCE_DELEGATES =
    /\.(contact|contactIdentity|listMembership|list|tag|contactTag|consentState|consentEvent|consentRetentionPolicy|suppression|topic|contactTopicPreference|audienceSnapshot\w*)\s*\.\s*(find|create|update|upsert|delete|count|aggregate|groupBy)/;
  const AUDIENCE_SQL = /\b(FROM|JOIN|INTO|UPDATE)\s+"?(contacts|contact_identities|list_memberships|lists|tags|contact_tags|consent_states|consent_events|suppressions|topics|contact_topic_preferences|audience_snapshot\w*)\b/i;

  it('scans the campaigns module', () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  it.each([
    ['Prisma delegates of Audience tables', AUDIENCE_DELEGATES],
    ['SQL over Audience tables', AUDIENCE_SQL],
    ['@workeasy/audience-infra', /from\s+'@workeasy\/audience-infra'/],
    ['Audience module internals', /from\s+'[^']*modules\/audience\//],
    ['the Audience module through a relative path', /from\s+'\.\.\/(\.\.\/)*audience\//],
  ])('no campaigns file references %s', (_label, pattern) => {
    const offenders = sources.filter((f) => pattern.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the scanner detects a violation (guards against a vacuous pass)', () => {
    expect(AUDIENCE_DELEGATES.test('await tx.contact.findMany({})')).toBe(true);
    expect(AUDIENCE_DELEGATES.test('await tx.consentState.findMany({})')).toBe(true);
    expect(AUDIENCE_SQL.test('SELECT id FROM contacts WHERE')).toBe(true);
  });
});
