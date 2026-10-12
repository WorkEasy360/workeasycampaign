/**
 * Milestone 6.4 — the Phase 6.1 domain against the shared wire contracts: what the domain produces (version snapshots,
 * readiness findings, event payloads) must satisfy the schemas the API will serialize and the database will store.
 */
import {
  CAMPAIGN_EVENT_PAYLOAD_SCHEMAS,
  type CampaignEventType,
  campaignVersionSnapshotV1Schema,
  campaignVersionSnapshotV2Schema,
  type EmailContentV1,
  readinessFindingSchema,
  updateCampaignRequest,
} from '@workeasy/shared';
import { describe, expect, it } from 'vitest';
import type { CampaignDraft } from './draft.js';
import { CAMPAIGN_EVENT_TYPES, type CampaignEventPayloads, campaignEvent } from './events.js';
import { preflightFindings, readinessFindings } from './readiness.js';
import { buildVersionSnapshot, contentHash, readStoredSnapshot, readVersionSnapshot } from './version.js';

const T = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const X = '44444444-4444-4444-8444-444444444444';

/** Body text of a snapshot whose content is v1 (fails loudly otherwise). */
const textOf = (v: { messages: readonly [{ content: { schema: string } }] }) => {
  const c = v.messages[0].content as EmailContentV1;
  expect(c.schema).toBe('email.content.v1');
  return c.body.text;
};

const ready = (over: Partial<CampaignDraft> = {}): CampaignDraft => ({
  name: 'Launch',
  channel: 'email',
  topicId: T,
  audience: { include: [{ type: 'list', listId: L }], exclude: [] },
  sender: { senderIdentityId: null, fromName: 'Acme', replyTo: 'hello@acme.test' },
  messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Hello', preheader: 'Pre', body: { format: 'text', text: 'Body' } } }],
  schedule: { mode: 'now', sendAt: null, timezone: 'UTC' },
  ...over,
});

describe('domain output satisfies the shared contracts', () => {
  it('every built snapshot parses with the shared campaign.version.v2 schema (content amendment C3), and reads back identically', () => {
    for (const at of [
      { mode: 'now' as const, sendAt: null, timezone: 'UTC' },
      { mode: 'at' as const, sendAt: '2026-10-05T03:30:00+05:30', timezone: 'Asia/Kolkata' },
    ]) {
      const v = buildVersionSnapshot(ready(), at);
      expect(campaignVersionSnapshotV2Schema.safeParse(v).success).toBe(true);
      expect(v.personalization.mode).toBe('none'); // v1 text is never interpreted
      expect(readVersionSnapshot(JSON.parse(JSON.stringify(v)))).toEqual(v);
    }
  });

  it('a draft accepted by the update contract and free of readiness errors always builds a valid snapshot (limits without a finding are request limits)', () => {
    const req = updateCampaignRequest.parse({
      expectedVersion: 1,
      sender: { senderIdentityId: null, fromName: ` ${'n'.repeat(100)} `, replyTo: 'a@b.co' },
      messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 's'.repeat(200), preheader: 'p'.repeat(200), body: { format: 'text', text: 'b' } } }],
    });
    const draft = ready({ sender: req.sender!, messages: req.messages! });
    const errors = readinessFindings(draft, { now: new Date(), deliveryAvailable: true }).filter((f) => f.severity === 'error');
    expect(errors).toEqual([]);
    expect(campaignVersionSnapshotV2Schema.safeParse(buildVersionSnapshot(draft, draft.schedule)).success).toBe(true);
  });

  describe('canonical email body: readiness validates exactly what the version stores', () => {
    const withBody = (text: string) =>
      ready({ messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Hello', preheader: '', body: { format: 'text', text } } }] });
    const ctx = { now: new Date(), deliveryAvailable: true };
    const codes = (d: CampaignDraft) => readinessFindings(d, ctx).map((f) => f.code);
    const at = { mode: 'now' as const, sendAt: null, timezone: 'UTC' };

    it('a whitespace-only body is BODY_MISSING and cannot become a version', () => {
      expect(codes(withBody(' \n\t  '))).toContain('BODY_MISSING');
      expect(() => buildVersionSnapshot(withBody(' \n\t '), at)).toThrow(/incomplete/);
    });

    it('leading/trailing whitespace is removed in the snapshot; inner whitespace is kept verbatim', () => {
      const v = buildVersionSnapshot(withBody('\n  Hello\n\n  world  \n'), at);
      expect(textOf(v)).toBe('Hello\n\n  world');
    });

    it('a body at the 100,000 limit with surrounding whitespace is ready AND builds a valid snapshot (no second interpretation)', () => {
      const d = withBody(`  ${'b'.repeat(100_000)}\n\n`);
      expect(codes(d)).not.toContain('BODY_TOO_LONG');
      const v = buildVersionSnapshot(d, at);
      expect(textOf(v)).toHaveLength(100_000);
      expect(campaignVersionSnapshotV2Schema.safeParse(v).success).toBe(true);
      expect(codes(withBody(`  ${'b'.repeat(100_001)}  `))).toContain('BODY_TOO_LONG');
    });

    it('the canonical snapshot and its content hash do not depend on surrounding whitespace', () => {
      const a = buildVersionSnapshot(withBody('Body'), at);
      const b = buildVersionSnapshot(withBody('   Body \n'), at);
      expect(b).toEqual(a);
      expect(contentHash(b)).toBe(contentHash(a));
      expect(contentHash(buildVersionSnapshot(withBody('Body!'), at))).not.toBe(contentHash(a));
    });
  });

  it('every readiness and pre-flight finding the domain emits parses with the shared finding schema', () => {
    const broken = ready({
      name: ' ',
      topicId: null,
      audience: { include: [], exclude: [{ type: 'list', listId: L }] },
      sender: { senderIdentityId: null, fromName: null, replyTo: 'nope' },
      messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: '', preheader: '', body: { format: 'text', text: '' } } }],
      schedule: { mode: 'at', sendAt: '2000-01-01T00:00:00Z', timezone: 'Not/AZone' },
    });
    const findings = [
      ...readinessFindings(broken, { now: new Date(), deliveryAvailable: false }),
      ...preflightFindings(
        ready({ audience: { include: [{ type: 'list', listId: L }], exclude: [{ type: 'list', listId: X }] } }),
        {
          topic: 'unavailable',
          sources: [
            { role: 'include', selector: { type: 'list', listId: L }, status: 'archived' },
            { role: 'exclude', selector: { type: 'list', listId: X }, status: 'not_found' },
          ],
          audience: { size: 10, capped: false },
          eligibility: { estimate: 2, sampleSize: 10 },
        },
        { now: new Date(), deliveryAvailable: true },
      ),
    ];
    expect(findings.length).toBeGreaterThan(10);
    for (const f of findings) expect(readinessFindingSchema.safeParse(f).success, f.code).toBe(true);
  });

  it('the domain event types are the shared contract, and representative payloads parse', () => {
    expect([...CAMPAIGN_EVENT_TYPES].sort()).toEqual(Object.keys(CAMPAIGN_EVENT_PAYLOAD_SCHEMAS).sort());
    const samples: { [K in CampaignEventType]: CampaignEventPayloads[K] } = {
      'campaign.created': { channel: 'email', clonedFrom: { campaignId: T, versionId: null } },
      'campaign.updated': { changes: ['audience', 'messages[0].content.subject'] },
      'campaign.deleted': {},
      'campaign.restored': {},
      'campaign.version_created': { versionId: T, number: 1, reason: 'sent_now', contentHash: 'a'.repeat(64), schema: 'campaign.version.v1' },
      'campaign.scheduled': { versionId: T, executionId: L, sendAt: '2026-10-07T10:00:00.000Z', mode: 'now' },
      'campaign.rescheduled': { executionId: L, from: '2026-10-07T10:00:00.000Z', to: '2026-10-08T10:00:00.000Z' },
      'campaign.unscheduled': { executionId: L, versionId: T },
      'campaign.started': { executionId: L },
      'campaign.audience_materialized': { executionId: L, capturedAt: '2026-10-07T10:00:00.000Z', audienceSize: 3, planned: 2, skipped: 1, skippedByReason: { CONSENT_MISSING: 1 } },
      'campaign.paused': { executionId: L, phase: 'materializing' },
      'campaign.resumed': { executionId: L, phase: 'delivering' },
      'campaign.cancelled': { executionId: null, stage: 'scheduled', counts: { planned: 0, skipped: 0, sent: 0, failed: 0, cancelled: 0, unknown: 0 } },
      'campaign.completed': { executionId: L, counts: { planned: 2, skipped: 1, sent: 2, failed: 0, cancelled: 0, unknown: 0 } },
      'campaign.failed': { executionId: L, failureClass: 'configuration', failureCode: 'TOPIC_UNAVAILABLE' },
      'campaign.returned_to_draft': { executionId: L },
    };
    for (const type of CAMPAIGN_EVENT_TYPES) {
      const e = campaignEvent(type, samples[type] as never);
      expect(CAMPAIGN_EVENT_PAYLOAD_SCHEMAS[type].safeParse(e.payload).success, type).toBe(true);
    }
  });
});

describe('content amendment: email.content.v2 versions, upcasting and historical integrity', () => {
  const at = { mode: 'now' as const, sendAt: null, timezone: 'UTC' };
  const blocks = (subject: string, ...b: unknown[]) =>
    ready({ messages: [{ variantKey: 'default', content: { schema: 'email.content.v2', subject, preheader: ' Pre ', body: { format: 'blocks', blocks: b } } }] });
  const ctx = { now: new Date(), deliveryAvailable: true };

  it('a ready v2 draft builds a v2 snapshot with merge_tags_v1 and the canonical content', () => {
    const d = blocks(' Hi {{ contact.first_name | "there" }} ', { id: 'h1', type: 'heading', level: 2, runs: [{ text: '' }] }, { id: 'p1', type: 'paragraph', runs: [{ text: '' }, { text: 'Hello' }] });
    expect(readinessFindings(d, ctx).filter((f) => f.severity === 'error')).toEqual([]);
    const v = buildVersionSnapshot(d, at);
    expect(campaignVersionSnapshotV2Schema.safeParse(v).success).toBe(true);
    expect(v.personalization.mode).toBe('merge_tags_v1');
    expect(v.messages[0].content).toEqual({ schema: 'email.content.v2', subject: 'Hi {{ contact.first_name | "there" }}', preheader: 'Pre', body: { format: 'blocks', blocks: [{ id: 'p1', type: 'paragraph', runs: [{ text: 'Hello' }] }] } });
  });

  it('v2 content problems are readiness findings with pointers into the draft, and cannot become a version', () => {
    const d = blocks('Hi {{ contact.secret }}', { id: 'b1', type: 'button', label: 'Go', href: 'javascript:alert(1)' });
    const f = readinessFindings(d, ctx).filter((x) => x.section === 'message');
    expect(f.map((x) => `${x.code} ${x.field}`)).toEqual(['MERGE_TAG_INVALID /messages/0/content/subject', 'LINK_INVALID /messages/0/content/body/blocks/0/href']);
    for (const x of f) expect(readinessFindingSchema.safeParse(x).success).toBe(true);
    expect(() => buildVersionSnapshot(d, at)).toThrow(/incomplete/);
  });

  it('a stored v1 version is read as stored for the wire, upcast for the domain, and its hash is unchanged', () => {
    const v1 = {
      schema: 'campaign.version.v1',
      channel: 'email',
      purpose: 'marketing',
      topic: { topicIds: [T], policy: 'block_unsubscribed' },
      audience: { include: [{ type: 'list', listId: L }], exclude: [] },
      sender: { senderIdentityId: null, fromName: 'Acme', replyTo: 'hello@acme.test' },
      messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Hello', preheader: 'Pre', body: { format: 'text', text: 'Body' } } }],
      tracking: { opens: false, clicks: false },
      compliance: { unsubscribeLink: 'required', listUnsubscribeHeader: 'required' },
      personalization: { mode: 'none' },
      schedule: { mode: 'now', sendAt: null, timezone: 'UTC' },
      abTest: null,
    };
    const before = contentHash(v1 as never);
    const stored = readStoredSnapshot(JSON.parse(JSON.stringify(v1)));
    expect(stored).toEqual(v1);
    expect(campaignVersionSnapshotV1Schema.safeParse(stored).success).toBe(true);
    expect(contentHash(stored)).toBe(before);
    const domain = readVersionSnapshot(JSON.parse(JSON.stringify(v1)));
    expect(domain.schema).toBe('campaign.version.v2');
    expect(campaignVersionSnapshotV2Schema.safeParse(domain).success).toBe(true);
    expect({ ...domain, schema: 'campaign.version.v1' }).toEqual(v1);
    expect(Object.isFrozen(domain.messages[0].content)).toBe(true);
  });

  it('unknown schema ids and tampered snapshots are refused on read', () => {
    expect(() => readStoredSnapshot({ schema: 'campaign.version.v9' })).toThrow(/Unknown version schema/);
    const v = JSON.parse(JSON.stringify(buildVersionSnapshot(blocks('Hi', { id: 'p1', type: 'paragraph', runs: [{ text: 'x' }] }), at)));
    v.personalization.mode = 'none';
    expect(() => readStoredSnapshot(v)).toThrow(/Invalid campaign.version.v2/);
  });
});
