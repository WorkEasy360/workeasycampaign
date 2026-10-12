import { readdirSync, readFileSync } from 'node:fs';
import { type AudienceDefinitionV1, ELIGIBILITY_REASONS, EVALUATED_ELIGIBILITY_REASONS } from '@workeasy/shared';
import { describe, expect, it } from 'vitest';
import {
  AUDIENCE_PAGE_SIZE,
  AudienceResolutionError,
  captureMembers,
  decodeSnapshotCursor,
  definitionErrors,
  definitionHash,
  encodeSnapshotCursor,
  pageLimit,
  pageMembers,
  assertCaptureRequest,
  captureKeyError,
  captureKeyOutcome,
} from './audience-definition.js';
import { type EligibilityFacts, evaluateEligibility } from './eligibility.js';
import { ELIGIBILITY_BATCH_LIMIT, EligibilityBatchTooLargeError, EligibilityEvaluator, EligibilityTopicNotFoundError } from './evaluator.js';
import { consentFingerprint } from './fingerprint.js';
import type { EligibilityFactsBatch, EligibilityFactsQuery, EligibilityFactsReader, TenantScope } from './ports.js';

// ─── purity ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe('audience-core is pure', () => {
  const srcDir = new URL('.', import.meta.url);
  const sources = readdirSync(srcDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it('production sources import only @workeasy/shared, node:crypto and each other', () => {
    expect(sources.length).toBeGreaterThan(0);
    for (const f of sources) {
      const text = readFileSync(new URL(f, srcDir), 'utf8');
      const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((m) => m[1]!);
      for (const s of specifiers) expect([`${f}: ${s}`]).toEqual([`${f}: ${s.startsWith('./') || s === '@workeasy/shared' || s === 'node:crypto' ? s : 'FORBIDDEN'}`]);
    }
  });

  it('declares no infrastructure dependency', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(Object.keys(pkg.dependencies)).toEqual(['@workeasy/shared']);
  });
});

// ─── fingerprint (frozen algorithm) ──────────────────────────────────────────────────────────────────────────────

describe('consent fingerprint', () => {
  it('is byte-identical to the Phase 5 algorithm (HMAC-SHA256 over consent-subject␀channel␀value, base64url)', () => {
    // Vectors computed with the pre-move apps/api implementation: hmac(secret, 'consent-subject', channel, value).
    expect(consentFingerprint('test-secret', 'email', 'ada@example.test')).toBe('ihLQ2QvQVg9X75pA1jDBHZU60BMTxMRNTZCb3RBS-NU');
    expect(consentFingerprint('test-secret', 'sms', '+14155550100')).toBe('aHKRhO_XG4Pluma_I9Y_xqiHxY98hUZnptJJ5uM2n0M');
  });
});

// ─── eligibility through the port ────────────────────────────────────────────────────────────────────────────────

const SECRET = 'test-secret';
const NOW = new Date('2026-10-03T12:00:00Z');
const scope: TenantScope<'tx'> = { tx: 'tx', orgId: 'org-1', workspaceId: 'ws-1' };
const fp = (value: string) => consentFingerprint(SECRET, 'email', value);

/** One contact's facts, built the way the adapter returns them. */
interface ContactFacts {
  id: string;
  subscriptionType?: string;
  deleted?: boolean;
  erased?: boolean;
  email?: string | null;
  consent?: { state: 'none' | 'pending' | 'granted' | 'withdrawn'; recordedAt?: Date; fingerprintOf?: string | null } | null;
  suppressed?: { by: 'contact' | 'address'; channel: string } | null;
  topic?: 'subscribed' | 'unsubscribed' | null;
}

class FakeReader implements EligibilityFactsReader<'tx'> {
  calls: EligibilityFactsQuery[] = [];
  constructor(
    private readonly contacts: ContactFacts[],
    private readonly topic: EligibilityFactsBatch['topic'] = { found: true, status: 'active' },
    private readonly pendingExpiryDays = 7,
  ) {}
  async load(s: TenantScope<'tx'>, q: EligibilityFactsQuery): Promise<EligibilityFactsBatch> {
    expect(s).toBe(scope);
    this.calls.push(q);
    const cs = this.contacts.filter((c) => q.contactIds.includes(c.id));
    return {
      topic: q.topicId ? this.topic : null,
      contacts: cs.map((c) => ({ id: c.id, deleted: !!c.deleted, erased: !!c.erased, subscriptionType: c.subscriptionType ?? 'marketing' })),
      identities: cs.filter((c) => c.email).map((c) => ({ id: `idn-${c.id}`, contactId: c.id, valueNormalized: c.email!, isPrimary: true })),
      suppressions: cs
        .filter((c) => c.suppressed)
        .map((c) => (c.suppressed!.by === 'contact' ? { contactId: c.id, valueNormalized: null, channel: c.suppressed!.channel, reason: 'manual' } : { contactId: null, valueNormalized: c.email!, channel: c.suppressed!.channel, reason: 'bounce' })),
      consentStates: cs
        .filter((c) => c.consent)
        .map((c) => ({ contactId: c.id, state: c.consent!.state, recordedAt: c.consent!.recordedAt ?? NOW, subjectFingerprint: c.consent!.fingerprintOf === null ? null : fp(c.consent!.fingerprintOf ?? c.email!) })),
      pendingExpiryDays: this.pendingExpiryDays,
      topicPreferences: q.topicId ? cs.filter((c) => c.topic).map((c) => ({ contactId: c.id, status: c.topic! })) : [],
    };
  }
}

const ok: Omit<ContactFacts, 'id'> = { email: 'a@x.test', consent: { state: 'granted' }, topic: 'subscribed' };
const evaluate = async (contacts: ContactFacts[], over: { topicId?: string; purpose?: 'marketing' | 'transactional' } = {}) => {
  const reader = new FakeReader(contacts);
  const r = await new EligibilityEvaluator(reader, SECRET, () => NOW).evaluate(scope, {
    contactIds: contacts.map((c) => c.id),
    channel: 'email',
    purpose: over.purpose ?? 'marketing',
    ...('topicId' in over ? { topicId: over.topicId } : { topicId: 'topic-1' }),
  });
  return { reader, r, codes: (id: string) => r.results.find((x) => x.contactId === id)!.reasons.map((x) => x.code) };
};

describe('eligibility v1 through EligibilityEvaluator (behaviour unchanged by the move)', () => {
  it('consent granted, subscribed to the topic, an address, nothing blocking → eligible, with the address identity id', async () => {
    const { r } = await evaluate([{ id: 'c1', ...ok }]);
    expect(r).toEqual({
      results: [{ contactId: 'c1', channel: 'email', purpose: 'marketing', topicId: 'topic-1', eligible: true, reasons: [], addressIdentityId: 'idn-c1' }],
      notFound: [],
    });
  });

  it.each([
    ['no consent recorded', { consent: null }, ['CONSENT_MISSING']],
    ['consent withdrawn', { consent: { state: 'withdrawn' } }, ['CONSENT_WITHDRAWN']],
    ['double opt-in pending', { consent: { state: 'pending', recordedAt: new Date('2026-10-01T00:00:00Z') } }, ['CONSENT_PENDING']],
    ['double opt-in expired (8 days)', { consent: { state: 'pending', recordedAt: new Date('2026-09-25T11:00:00Z') } }, ['CONSENT_EXPIRED']],
    ['consent given for a previous address', { consent: { state: 'granted', fingerprintOf: 'old@x.test' } }, ['CONSENT_ADDRESS_CHANGED']],
    ['consent with no recorded fingerprint', { consent: { state: 'granted', fingerprintOf: null } }, ['CONSENT_ADDRESS_CHANGED']],
    ['globally unsubscribed (administrative status)', { subscriptionType: 'unsubscribed' }, ['UNSUBSCRIBED']],
    ['non-marketing contact', { subscriptionType: 'non_marketing' }, ['NOT_MARKETING']],
    ['suppressed by contact, channel all', { suppressed: { by: 'contact', channel: 'all' } }, ['SUPPRESSED']],
    ['suppressed by address, this channel', { suppressed: { by: 'address', channel: 'email' } }, ['SUPPRESSED']],
    ['topic UNSUBSCRIBED', { topic: 'unsubscribed' }, ['TOPIC_NOT_SUBSCRIBED']],
    ['topic UNSET — not evidence of consent', { topic: null }, ['TOPIC_NOT_SUBSCRIBED']],
    ['no address for the channel', { email: null, consent: { state: 'granted' } }, ['NO_ADDRESS']],
    ['deleted contact', { deleted: true }, ['CONTACT_DELETED']],
  ] as const)('%s', async (_label, over, expected) => {
    const { codes } = await evaluate([{ id: 'c1', ...ok, ...(over as Partial<ContactFacts>) }]);
    expect(codes('c1')).toEqual(expected);
  });

  it('combined blockers are all reported, most fundamental first', async () => {
    const { codes } = await evaluate([{ id: 'c1', subscriptionType: 'unsubscribed', email: 'a@x.test', consent: { state: 'withdrawn' }, suppressed: { by: 'contact', channel: 'email' }, topic: 'unsubscribed' }]);
    expect(codes('c1')).toEqual(['UNSUBSCRIBED', 'SUPPRESSED', 'CONSENT_WITHDRAWN', 'TOPIC_NOT_SUBSCRIBED']);
  });

  it('transactional skips subscription, consent and topic — never suppression', async () => {
    const t = await evaluate([{ id: 'c1', email: 'a@x.test', subscriptionType: 'unsubscribed', consent: null, topic: null }], { purpose: 'transactional' });
    expect(t.codes('c1')).toEqual([]);
    const s = await evaluate([{ id: 'c1', ...ok, suppressed: { by: 'contact', channel: 'all' } }], { purpose: 'transactional' });
    expect(s.codes('c1')).toEqual(['SUPPRESSED']);
  });

  it('a suppression for another channel does not block', async () => {
    const { codes } = await evaluate([{ id: 'c1', ...ok, suppressed: { by: 'contact', channel: 'sms' } }]);
    expect(codes('c1')).toEqual([]);
  });

  it('no topic requested → no topic check', async () => {
    const { codes } = await evaluate([{ id: 'c1', ...ok, topic: null }], { topicId: undefined });
    expect(codes('c1')).toEqual([]);
  });

  it('an unknown topic fails the whole request', async () => {
    const reader = new FakeReader([{ id: 'c1', ...ok }], { found: false });
    await expect(new EligibilityEvaluator(reader, SECRET).evaluate(scope, { contactIds: ['c1'], channel: 'email', purpose: 'marketing', topicId: 'nope' })).rejects.toBeInstanceOf(
      EligibilityTopicNotFoundError,
    );
  });

  it('unknown ids are reported in notFound, never evaluated; erased contacts expose no address id', async () => {
    const { r } = await evaluate([{ id: 'c1', ...ok, erased: true }]);
    expect(r.results[0]!.addressIdentityId).toBeNull();
    const reader = new FakeReader([{ id: 'c1', ...ok }]);
    const res = await new EligibilityEvaluator(reader, SECRET).evaluate(scope, { contactIds: ['c1', 'other-ws-contact'], channel: 'email', purpose: 'marketing' });
    expect(res.results.map((x) => x.contactId)).toEqual(['c1']);
    expect(res.notFound).toEqual(['other-ws-contact']);
  });

  it('loads facts once per batch with de-duplicated ids (no per-contact loading)', async () => {
    const contacts = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, ...ok }));
    const reader = new FakeReader(contacts);
    const r = await new EligibilityEvaluator(reader, SECRET, () => NOW).evaluate(scope, {
      contactIds: [...contacts.map((c) => c.id), 'c0', 'c1'],
      channel: 'email',
      purpose: 'marketing',
      topicId: 'topic-1',
    });
    expect(reader.calls).toHaveLength(1);
    expect(reader.calls[0]!.contactIds).toHaveLength(100);
    expect(r.results.every((x) => x.eligible)).toBe(true);
  });
});

// ─── Eligibility v1.1 (docs/eligibility.md §v1.1, decisions D, E, F) ───────────────────────────────────────────

describe('eligibility v1.1 — topic policy truth table', () => {
  type Policy = 'require_subscription' | 'block_unsubscribed' | undefined;
  const base: EligibilityFacts = {
    contact: { id: 'c', deleted: false, erased: false, subscriptionType: 'marketing' },
    addresses: ['a@x.test'],
    suppressions: [],
    consent: { state: 'granted', forCurrentAddress: true },
    topic: { status: 'active', preference: 'none' },
  };
  const run = (f: Partial<EligibilityFacts>, policy: Policy, purpose: 'marketing' | 'transactional' = 'marketing') =>
    evaluateEligibility({ ...base, ...f }, { channel: 'email', purpose, topicId: 't', ...(policy ? { topicPolicy: policy } : {}) }).reasons.map((r) => r.code);
  const topic = (preference: 'none' | 'subscribed' | 'unsubscribed', status: 'active' | 'archived' = 'active') => ({ topic: { status, preference } });
  const consent = (state: 'none' | 'pending' | 'expired' | 'granted' | 'withdrawn', forCurrentAddress = true) => ({ consent: { state, forCurrentAddress } });
  const TNS = 'TOPIC_NOT_SUBSCRIBED';

  // [row, facts, block_unsubscribed (campaigns), require_subscription (v1)] — docs/eligibility.md truth table, verbatim.
  const ROWS: [string, Partial<EligibilityFacts>, string[], string[], ('marketing' | 'transactional')?][] = [
    ['1 valid consent, unset topic', { ...topic('none') }, [], [TNS]],
    ['2 valid consent, subscribed', { ...topic('subscribed') }, [], []],
    ['3 valid consent, unsubscribed topic', { ...topic('unsubscribed') }, ['TOPIC_UNSUBSCRIBED'], [TNS]],
    ['4 missing consent, subscribed', { ...consent('none'), ...topic('subscribed') }, ['CONSENT_MISSING'], ['CONSENT_MISSING']],
    ['5 missing consent, unset', { ...consent('none'), ...topic('none') }, ['CONSENT_MISSING'], ['CONSENT_MISSING', TNS]],
    ['6 withdrawn consent, subscribed', { ...consent('withdrawn'), ...topic('subscribed') }, ['CONSENT_WITHDRAWN'], ['CONSENT_WITHDRAWN']],
    ['7 pending request, unset', { ...consent('pending'), ...topic('none') }, ['CONSENT_PENDING'], ['CONSENT_PENDING', TNS]],
    ['7 expired request, unset', { ...consent('expired'), ...topic('none') }, ['CONSENT_EXPIRED'], ['CONSENT_EXPIRED', TNS]],
    ['8 global unsubscribe', { contact: { ...base.contact, subscriptionType: 'unsubscribed' }, ...topic('subscribed') }, ['UNSUBSCRIBED'], ['UNSUBSCRIBED']],
    ['9 non-marketing contact', { contact: { ...base.contact, subscriptionType: 'non_marketing' }, ...topic('subscribed') }, ['NOT_MARKETING'], ['NOT_MARKETING']],
    ['10 suppressed', { suppressions: [{ channel: 'email', reason: 'manual' }], ...topic('subscribed') }, ['SUPPRESSED'], ['SUPPRESSED']],
    ['11 changed address', { ...consent('granted', false), ...topic('subscribed') }, ['CONSENT_ADDRESS_CHANGED'], ['CONSENT_ADDRESS_CHANGED']],
    ['12 archived topic', { ...topic('subscribed', 'archived') }, ['TOPIC_INACTIVE'], ['TOPIC_INACTIVE']],
    ['13 deleted contact', { contact: { ...base.contact, deleted: true }, ...topic('subscribed') }, ['CONTACT_DELETED'], ['CONTACT_DELETED']],
    ['14 no email address', { addresses: [], ...consent('none'), ...topic('none') }, ['NO_ADDRESS', 'CONSENT_MISSING'], ['NO_ADDRESS', 'CONSENT_MISSING', TNS]],
    ['14a consent only on another channel', { ...consent('none'), ...topic('subscribed') }, ['CONSENT_MISSING'], ['CONSENT_MISSING']],
    ['14b unsubscribed topic and missing consent', { ...consent('none'), ...topic('unsubscribed') }, ['CONSENT_MISSING', 'TOPIC_UNSUBSCRIBED'], ['CONSENT_MISSING', TNS]],
    ['14c global unsubscribe, unset topic', { contact: { ...base.contact, subscriptionType: 'unsubscribed' }, ...topic('none') }, ['UNSUBSCRIBED'], ['UNSUBSCRIBED', TNS]],
    ['14d suppressed, unset topic', { suppressions: [{ channel: 'all', reason: 'manual' }], ...topic('none') }, ['SUPPRESSED'], ['SUPPRESSED', TNS]],
    ['14e changed address, unset topic', { ...consent('granted', false), ...topic('none') }, ['CONSENT_ADDRESS_CHANGED'], ['CONSENT_ADDRESS_CHANGED', TNS]],
    ['15 transactional (policy ignored)', { contact: { ...base.contact, subscriptionType: 'unsubscribed' }, ...consent('none'), ...topic('unsubscribed') }, [], [], 'transactional'],
    ['16 transactional, suppressed', { suppressions: [{ channel: 'all', reason: 'manual' }], ...topic('unsubscribed') }, ['SUPPRESSED'], ['SUPPRESSED'], 'transactional'],
  ];

  it.each(ROWS)('%s', (_row, facts, campaigns, v1, purpose) => {
    expect(run(facts, 'block_unsubscribed', purpose)).toEqual(campaigns);
    expect(run(facts, 'require_subscription', purpose)).toEqual(v1);
    // omitted ⇒ byte-for-byte v1
    expect(evaluateEligibility({ ...base, ...facts }, { channel: 'email', purpose: purpose ?? 'marketing', topicId: 't' })).toEqual(
      evaluateEligibility({ ...base, ...facts }, { channel: 'email', purpose: purpose ?? 'marketing', topicId: 't', topicPolicy: 'require_subscription' }),
    );
  });

  it('the six policy × topic-state combinations', () => {
    expect([run(topic('none'), undefined), run(topic('subscribed'), undefined), run(topic('unsubscribed'), undefined)]).toEqual([[TNS], [], [TNS]]);
    expect([run(topic('none'), 'block_unsubscribed'), run(topic('subscribed'), 'block_unsubscribed'), run(topic('unsubscribed'), 'block_unsubscribed')]).toEqual([
      [],
      [],
      ['TOPIC_UNSUBSCRIBED'],
    ]);
  });

  it('UNSET is never consent: no topic state bypasses any other gate under either policy', () => {
    const blockers: [string, Partial<EligibilityFacts>][] = [
      ['CONSENT_MISSING', consent('none')],
      ['CONSENT_WITHDRAWN', consent('withdrawn')],
      ['CONSENT_EXPIRED', consent('expired')],
      ['CONSENT_PENDING', consent('pending')],
      ['CONSENT_ADDRESS_CHANGED', consent('granted', false)],
      ['SUPPRESSED', { suppressions: [{ channel: 'all', reason: 'manual' }] }],
      ['UNSUBSCRIBED', { contact: { ...base.contact, subscriptionType: 'unsubscribed' } }],
      ['NO_ADDRESS', { addresses: [] }],
    ];
    for (const [code, f] of blockers) {
      for (const pref of ['none', 'subscribed', 'unsubscribed'] as const) {
        for (const policy of ['block_unsubscribed', 'require_subscription', undefined] as const) {
          const r = evaluateEligibility({ ...base, ...f, ...topic(pref) }, { channel: 'email', purpose: 'marketing', topicId: 't', ...(policy ? { topicPolicy: policy } : {}) });
          expect(r.eligible).toBe(false);
          expect(r.reasons.map((x) => x.code)).toContain(code);
        }
      }
    }
  });

  it('TOPIC_UNSUBSCRIBED is a stable, evaluated reason placed right after TOPIC_INACTIVE; no code renamed', () => {
    expect(ELIGIBILITY_REASONS.indexOf('TOPIC_UNSUBSCRIBED')).toBe(ELIGIBILITY_REASONS.indexOf('TOPIC_INACTIVE') + 1);
    expect(EVALUATED_ELIGIBILITY_REASONS).toContain('TOPIC_UNSUBSCRIBED');
    expect(EVALUATED_ELIGIBILITY_REASONS).not.toContain('FREQUENCY_CAP');
    expect([...ELIGIBILITY_REASONS]).toEqual(expect.arrayContaining(['TOPIC_NOT_SUBSCRIBED', 'TOPIC_INACTIVE', 'EXCLUDED_BY_CAMPAIGN']));
  });
});

describe('eligibility v1.1 — batch size (decision D)', () => {
  const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const variety = (i: number): ContactFacts => {
    const kinds: Omit<ContactFacts, 'id'>[] = [ok, { ...ok, consent: null }, { ...ok, topic: 'unsubscribed' }, { ...ok, topic: null }, { ...ok, suppressed: { by: 'contact', channel: 'all' } }];
    return { id: uuid(i), ...kinds[i % kinds.length]! };
  };
  const byId = (r: { results: { contactId: string }[] }) => Object.fromEntries(r.results.map((x) => [x.contactId, x]));

  it.each([1, 100, 101, 500, 501, 1_000])('%i contacts: batching never changes any result', async (n) => {
    const contacts = Array.from({ length: n }, (_, i) => variety(i));
    const ev = new EligibilityEvaluator(new FakeReader(contacts), SECRET, () => NOW);
    const req = { channel: 'email' as const, purpose: 'marketing' as const, topicId: 'topic-1', topicPolicy: 'block_unsubscribed' as const };
    const unknown = n < 1_000 ? [uuid(999_999)] : []; // a foreign/unknown id is reported, never evaluated
    const batched = await ev.evaluateInBatches(scope, { ...req, contactIds: [...contacts.map((c) => c.id), ...unknown] });
    const single = await Promise.all(contacts.map((c) => ev.evaluate(scope, { ...req, contactIds: [c.id] })));
    expect(byId(batched)).toEqual(byId({ results: single.flatMap((s) => s.results) }));
    expect(batched.results).toHaveLength(n);
    expect(batched.notFound).toEqual(unknown);
  });

  it('one evaluate call is limited to the benchmarked 500 distinct ids; evaluateInBatches to one 1,000-id page', async () => {
    const contacts = Array.from({ length: 1_001 }, (_, i) => variety(i));
    const ev = new EligibilityEvaluator(new FakeReader(contacts), SECRET, () => NOW);
    const req = { channel: 'email' as const, purpose: 'marketing' as const };
    expect(ELIGIBILITY_BATCH_LIMIT).toBe(500);
    await expect(ev.evaluate(scope, { ...req, contactIds: contacts.slice(0, 500).map((c) => c.id) })).resolves.toBeDefined();
    await expect(ev.evaluate(scope, { ...req, contactIds: contacts.slice(0, 501).map((c) => c.id) })).rejects.toBeInstanceOf(EligibilityBatchTooLargeError);
    // duplicates do not count against the limit
    await expect(ev.evaluate(scope, { ...req, contactIds: [...contacts.slice(0, 500).map((c) => c.id), contacts[0]!.id] })).resolves.toBeDefined();
    await expect(ev.evaluateInBatches(scope, { ...req, contactIds: contacts.map((c) => c.id) })).rejects.toBeInstanceOf(EligibilityBatchTooLargeError);
  });

  it('an unknown topic still fails the whole request when batched', async () => {
    const ev = new EligibilityEvaluator(new FakeReader([variety(0)], { found: false }), SECRET);
    await expect(ev.evaluateInBatches(scope, { contactIds: [uuid(0)], channel: 'email', purpose: 'marketing', topicId: 'x' })).rejects.toBeInstanceOf(EligibilityTopicNotFoundError);
  });
});

// ─── Audience Resolution v1 rules ────────────────────────────────────────────────────────────────────────────────

/** Deterministic UUIDs; hex-padded so text order equals numeric order (as PostgreSQL orders uuid). */
const u = (n: number, group = '8000') => `00000000-0000-4000-${group}-${n.toString(16).padStart(12, '0')}`;
const L = (n: number) => u(n, '8001'); // list ids
const T = (n: number) => u(n, '8002'); // tag ids
const list = (id: string) => ({ type: 'list' as const, listId: id });
const tag = (id: string) => ({ type: 'tag' as const, tagId: id });
const def = (include: AudienceDefinitionV1['include'], exclude: AudienceDefinitionV1['exclude'] = []): AudienceDefinitionV1 => ({ include, exclude });
const codesOf = (raw: unknown) => definitionErrors(raw).map((e) => e.code);

describe('audience definition rules', () => {
  it('accepts lists and tags within limits', () => {
    expect(definitionErrors(def([list(L(1)), tag(T(1))], [list(L(2))]))).toEqual([]);
    expect(definitionErrors(def(Array.from({ length: 25 }, (_, i) => list(L(i))), Array.from({ length: 25 }, (_, i) => tag(T(i)))))).toEqual([]);
  });

  it.each([
    ['not an object', null],
    ['missing exclude', { include: [list(L(1))] }],
    ['extra field', { include: [list(L(1))], exclude: [], segment: 's' }],
    ['empty include', def([])],
    ['26 includes', def(Array.from({ length: 26 }, (_, i) => list(L(i))))],
    ['26 excludes', def([list(L(99))], Array.from({ length: 26 }, (_, i) => list(L(i))))],
    ['duplicate selector', def([list(L(1)), list(L(1))])],
    ['duplicate selector differing only in case', def([list(L(10)), list(L(10).toUpperCase())])],
    ['included and excluded', def([list(L(1))], [list(L(1))])],
    ['unknown selector type', { include: [{ type: 'segment', segmentId: u(1) }], exclude: [] }],
    ['selector with extra key', { include: [{ type: 'list', listId: L(1), tagId: T(1) }], exclude: [] }],
    ['empty id', { include: [{ type: 'tag', tagId: '' }], exclude: [] }],
    ['non-UUID id', { include: [{ type: 'list', listId: 'l1' }], exclude: [] }],
    ['SQL in an id', { include: [{ type: 'list', listId: `${L(1)}' OR 1=1 --` }], exclude: [] }],
  ])('rejects %s as AUDIENCE_DEFINITION_INVALID', (_label, raw) => {
    const c = codesOf(raw);
    expect(c.length).toBeGreaterThan(0);
    expect(new Set(c)).toEqual(new Set(['AUDIENCE_DEFINITION_INVALID']));
  });

  it('definition hash identifies the set, not the order or id case; include and exclude are distinct', () => {
    expect(definitionHash(def([list(L(1)), tag(T(2))], [list(L(3))]))).toBe(definitionHash(def([tag(T(2)), list(L(1))], [list(L(3))])));
    expect(definitionHash(def([list(L(1).toUpperCase())]))).toBe(definitionHash(def([list(L(1))])));
    expect(definitionHash(def([list(L(1))], [list(L(3))]))).not.toBe(definitionHash(def([list(L(3))], [list(L(1))])));
    expect(definitionHash(def([list(u(1))]))).not.toBe(definitionHash(def([tag(u(1))])));
    expect(definitionHash(def([list(L(1))]))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('capture-key identity (decisions B and C)', () => {
  const owner = { ownerKind: 'campaign_execution', ownerId: u(7) };
  const h = definitionHash(def([list(L(1))]));
  const existing = { definitionHash: h, ...owner, released: false };

  it('same definition and owner → reuse; different definition or owner → conflict', () => {
    expect(captureKeyOutcome(existing, { definitionHash: h, ...owner })).toBe('reuse');
    expect(captureKeyOutcome(existing, { definitionHash: h, ...owner, ownerId: u(7).toUpperCase() })).toBe('reuse');
    expect(captureKeyOutcome(existing, { definitionHash: definitionHash(def([list(L(2))])), ...owner })).toBe('conflict');
    expect(captureKeyOutcome(existing, { definitionHash: h, ...owner, ownerId: u(8) })).toBe('conflict');
  });

  it('a released key is final whatever is asked', () => {
    const released = { ...existing, released: true };
    expect(captureKeyOutcome(released, { definitionHash: h, ...owner })).toBe('released');
    expect(captureKeyOutcome(released, { definitionHash: 'f'.repeat(64), ...owner, ownerId: u(9) })).toBe('released');
    expect(captureKeyError('released').code).toBe('AUDIENCE_SNAPSHOT_NOT_FOUND');
    expect(captureKeyError('conflict').code).toBe('AUDIENCE_SNAPSHOT_KEY_CONFLICT');
  });

  it('capture keys and owners are validated before any SQL', () => {
    expect(() => assertCaptureRequest(u(1), { kind: 'campaign_execution', id: u(1) })).not.toThrow();
    expect(() => assertCaptureRequest('', { kind: 'campaign_execution', id: u(1) })).toThrow(TypeError);
    expect(() => assertCaptureRequest('k'.repeat(201), { kind: 'campaign_execution', id: u(1) })).toThrow(TypeError);
    expect(() => assertCaptureRequest(u(1), { kind: 'campaign_execution', id: 'x' })).toThrow(TypeError);
    expect(() => assertCaptureRequest(u(1), { kind: 'journey' as 'campaign_execution', id: u(1) })).toThrow(TypeError);
  });
});

describe('audience capture semantics (reference for the adapter)', () => {
  const ids = { a: u(1, '8100'), b: u(2, '8100'), c: u(3, '8100'), d: u(4, 'f100') };
  const members = new Map<string, string[]>([
    [`list:${L(1)}`, [ids.c, ids.a, ids.b]],
    [`tag:${T(1)}`, [ids.b, ids.d]],
    [`list:${L(9)}`, [ids.b]],
  ]);
  const live = new Set([ids.a, ids.b, ids.c, ids.d]);

  it('union of includes minus union of excludes, each contact once, ascending', () => {
    expect(captureMembers(def([list(L(1)), tag(T(1))]), members, live)).toEqual([ids.a, ids.b, ids.c, ids.d]);
    expect(captureMembers(def([list(L(1)), tag(T(1))], [list(L(9))]), members, live)).toEqual([ids.a, ids.c, ids.d]);
  });

  it('only contacts live at T0; consent and suppression are not applied here', () => {
    expect(captureMembers(def([list(L(1))]), members, new Set([ids.a, ids.c]))).toEqual([ids.a, ids.c]);
  });

  it('a missing source is AUDIENCE_SOURCE_NOT_FOUND; an invalid definition never resolves', () => {
    expect(() => captureMembers(def([list(L(404))]), members, live)).toThrow(expect.objectContaining({ code: 'AUDIENCE_SOURCE_NOT_FOUND' }));
    expect(() => captureMembers(def([list(L(1))], [list(L(404))]), members, live)).toThrow(expect.objectContaining({ code: 'AUDIENCE_SOURCE_NOT_FOUND' }));
    expect(() => captureMembers(def([list(L(1))], [list(L(1))]), members, live)).toThrow(AudienceResolutionError);
  });

  it('an existing but empty source is an empty audience, not a missing source', () => {
    expect(captureMembers(def([list(L(5))]), new Map([[`list:${L(5)}`, []]]), live)).toEqual([]);
  });
});

describe('snapshot paging', () => {
  const snap = u(1, '9000');
  const sorted = Array.from({ length: 2_503 }, (_, i) => u(i));
  const all = (limit?: number) => {
    const out: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p = pageMembers(snap, sorted, { cursor, limit });
      out.push(...p.contactIds);
      cursor = p.cursor;
      pages++;
    } while (cursor);
    return { out, pages };
  };

  it('pages cover the snapshot exactly once, in order, with the default and a custom size', () => {
    expect(all()).toEqual({ out: sorted, pages: 3 });
    expect(all(7).out).toEqual(sorted);
  });

  it('is deterministic: the same cursor returns the same page', () => {
    const first = pageMembers(snap, sorted, { cursor: null, limit: 100 });
    expect(pageMembers(snap, sorted, { cursor: first.cursor, limit: 100 })).toEqual(pageMembers(snap, sorted, { cursor: first.cursor, limit: 100 }));
  });

  it('completion is cursor === null, also when the size is an exact multiple of the page', () => {
    const four = [u(1), u(2), u(3), u(4)];
    const p1 = pageMembers(snap, four, { cursor: null, limit: 2 });
    expect(p1).toMatchObject({ contactIds: [u(1), u(2)] });
    expect(pageMembers(snap, four, { cursor: p1.cursor, limit: 2 })).toEqual({ contactIds: [u(3), u(4)], cursor: null });
    expect(pageMembers(snap, [], { cursor: null })).toEqual({ contactIds: [], cursor: null });
  });

  it('page size is bounded to 1–1,000', () => {
    expect(pageLimit(undefined)).toBe(AUDIENCE_PAGE_SIZE.default);
    expect(pageLimit(1)).toBe(1);
    expect(pageLimit(1_000)).toBe(1_000);
    for (const bad of [0, -1, 1_001, 1.5, Number.NaN]) expect(() => pageLimit(bad)).toThrow(expect.objectContaining({ code: 'AUDIENCE_LIMIT_INVALID' }));
  });

  it('cursors are opaque, bound to their snapshot, carry a UUID position, and tampering is refused', () => {
    const c = encodeSnapshotCursor(snap, u(99));
    expect(decodeSnapshotCursor(snap, c)).toBe(u(99));
    expect(() => decodeSnapshotCursor(u(2, '9000'), c)).toThrow(expect.objectContaining({ code: 'AUDIENCE_CURSOR_INVALID' }));
    const forged = (body: unknown) => Buffer.from(JSON.stringify(body)).toString('base64url');
    const bad = ['', 'not-base64!', forged({ v: 2, s: snap, a: u(1) }), forged([]), forged({ v: 1, s: snap, a: 'x' }), forged({ v: 1, s: snap, a: `${u(1)}' OR '1'='1` })];
    for (const b of bad) expect(() => decodeSnapshotCursor(snap, b)).toThrow(expect.objectContaining({ code: 'AUDIENCE_CURSOR_INVALID' }));
  });
});
