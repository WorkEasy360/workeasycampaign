import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp } from './support.js';

/** Eligibility v1.1 over HTTP (docs/eligibility.md §v1.1): optional `topicPolicy`; omitted ⇒ v1; HTTP limit stays 100. */
let t: TestApp;
let owner: Agent;
let W: string;
let topicId: string;
const url = (p: string) => `/v1/workspaces/${W}${p}`;

beforeAll(async () => {
  await resetTestDatabase();
  t = await startTestApp();
  owner = await signUp(t, undefined, 'Owner');
  W = (await createOrg(owner, 'Policy Co')).workspaceId;
  topicId = ((await owner.get(url('/topics'))).body.data as { id: string; key: string }[]).find((x) => x.key === 'marketing')!.id;
});
afterAll(async () => t?.close());

async function consentedContact(email: string) {
  const c = (await owner.post(url('/contacts'), { email })).body as { id: string };
  await owner.post(url(`/contacts/${c.id}/consent`), { channel: 'email', action: 'subscribed', source: 'form', lawfulBasis: 'consent', evidenceNote: 'Website form' });
  return c.id;
}
const codes = async (contactId: string, extra: Record<string, unknown> = {}) => {
  const r = await owner.post(url('/eligibility/check'), { contactIds: [contactId], channel: 'email', topicId, ...extra });
  expect(r.status).toBe(200);
  return r.body.results[0].reasons.map((x: { code: string }) => x.code) as string[];
};

describe('eligibility v1.1 over HTTP', () => {
  it('topic UNSET: v1 (omitted or require_subscription) blocks; block_unsubscribed passes the topic gate', async () => {
    const id = await consentedContact('unset@example.test');
    expect(await codes(id)).toEqual(['TOPIC_NOT_SUBSCRIBED']);
    expect(await codes(id, { topicPolicy: 'require_subscription' })).toEqual(['TOPIC_NOT_SUBSCRIBED']);
    expect(await codes(id, { topicPolicy: 'block_unsubscribed' })).toEqual([]);
  });

  it('topic UNSUBSCRIBED: v1 reports TOPIC_NOT_SUBSCRIBED; block_unsubscribed reports TOPIC_UNSUBSCRIBED', async () => {
    const id = await consentedContact('unsub@example.test');
    expect((await owner.put(url(`/contacts/${id}/topics/${topicId}`), { status: 'unsubscribed' })).status).toBe(200);
    expect(await codes(id)).toEqual(['TOPIC_NOT_SUBSCRIBED']);
    expect(await codes(id, { topicPolicy: 'block_unsubscribed' })).toEqual(['TOPIC_UNSUBSCRIBED']);
  });

  it('UNSET is not consent: without channel consent the campaigns policy still blocks', async () => {
    const c = (await owner.post(url('/contacts'), { email: 'noconsent@example.test' })).body as { id: string };
    expect(await codes(c.id, { topicPolicy: 'block_unsubscribed' })).toEqual(['CONSENT_MISSING']);
  });

  it('omitting topicPolicy returns exactly the v1 response', async () => {
    const id = await consentedContact('same@example.test');
    const body = { contactIds: [id, randomUUID()], channel: 'email', topicId };
    const omitted = await owner.post(url('/eligibility/check'), body);
    const explicit = await owner.post(url('/eligibility/check'), { ...body, topicPolicy: 'require_subscription' });
    expect(omitted.body).toEqual(explicit.body);
    expect(Object.keys(omitted.body.results[0]).sort()).toEqual(['addressIdentityId', 'channel', 'contactId', 'eligible', 'purpose', 'reasons', 'topicId']);
  });

  it('rejects an unknown policy and keeps the HTTP limit at 100 ids', async () => {
    const bad = await owner.post(url('/eligibility/check'), { contactIds: [randomUUID()], channel: 'email', topicPolicy: 'opt_out' });
    expect(bad.status).toBe(400);
    const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
    const hundred = await owner.post(url('/eligibility/check'), { contactIds: ids(100), channel: 'email', topicPolicy: 'block_unsubscribed' });
    expect(hundred.status).toBe(200);
    expect(hundred.body.notFound).toHaveLength(100);
    const over = await owner.post(url('/eligibility/check'), { contactIds: ids(101), channel: 'email' });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('validation_failed');
  });
});
