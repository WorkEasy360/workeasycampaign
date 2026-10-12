/**
 * Milestone 6.4 — campaign wire contracts (docs/contracts/phase-6-campaign.md). Schema behaviour only; the domain's use
 * of these contracts is tested in apps/api/src/modules/campaigns/domain/campaign-contracts.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  campaignCapabilitiesSchema,
  campaignCountsByStatusSchema,
  campaignListQuery,
  campaignRecipientsQuery,
  campaignViewSchema,
  cloneCampaignRequest,
  createCampaignRequest,
  pageOf,
  rescheduleCampaignRequest,
  scheduleCampaignRequest,
  updateCampaignRequest,
  versionDetailSchema,
} from './api/campaigns.js';
import { API_ERROR_CODES } from './api/common.js';
import {
  CAMPAIGN_EVENT_PAYLOAD_SCHEMAS,
  CAMPAIGN_EVENT_TYPES,
  CAMPAIGN_STATUSES,
  campaignVersionSnapshotV1Schema,
  EXECUTION_STATUSES,
  preflightResultSchema,
  READINESS_FINDING_CODES,
  readinessFindingSchema,
  RECIPIENT_STATUSES,
} from './campaigns.js';

const T = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const G = '33333333-3333-4333-8333-333333333333';

const snapshot = () => ({
  schema: 'campaign.version.v1',
  channel: 'email',
  purpose: 'marketing',
  topic: { topicIds: [T], policy: 'block_unsubscribed' },
  audience: { include: [{ type: 'list', listId: L }], exclude: [{ type: 'tag', tagId: G }] },
  sender: { senderIdentityId: null, fromName: 'Acme', replyTo: 'hello@acme.test' },
  messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Hi', preheader: '', body: { format: 'text', text: 'Body' } } }],
  tracking: { opens: false, clicks: false },
  compliance: { unsubscribeLink: 'required', listUnsubscribeHeader: 'required' },
  personalization: { mode: 'none' },
  schedule: { mode: 'at', sendAt: '2026-10-04T22:00:00.000Z', timezone: 'Asia/Kolkata' },
  abTest: null,
});

describe('lifecycle values (contract §2.1, §5.1, §7.1, §3.2)', () => {
  it('match the contract exactly', () => {
    expect(CAMPAIGN_STATUSES).toEqual(['draft', 'scheduled', 'sending', 'paused', 'completed', 'cancelled', 'failed']);
    expect(EXECUTION_STATUSES).toEqual(['pending', 'materializing', 'delivering', 'paused', 'completed', 'cancelled', 'failed']);
    expect(RECIPIENT_STATUSES).toHaveLength(9);
    // 23 frozen in 6.4 + ELIGIBILITY_ESTIMATE_UNAVAILABLE (approved degraded mode, 2026-10-07; contract §3.3)
    // + 4 content codes (content amendment §2, 2026-10-08; additive)
    // + 6 content v3 codes (Phase 7 content amendment §C, 2026-10-08; additive)
    // + SENDER_NOT_VERIFIED (Phase 7 campaign amendment §S, 2026-10-09; additive)
    // + TEMPLATE_MISSING, TEMPLATE_INVALID (messaging amendment §2, 2026-10-09; additive)
    expect(READINESS_FINDING_CODES).toHaveLength(37);
    expect(READINESS_FINDING_CODES).toContain('SENDER_NOT_VERIFIED');
    for (const code of ['TEMPLATE_MISSING', 'TEMPLATE_INVALID']) expect(READINESS_FINDING_CODES).toContain(code);
    expect(READINESS_FINDING_CODES).toContain('ELIGIBILITY_ESTIMATE_UNAVAILABLE');
    for (const code of ['MERGE_TAG_INVALID', 'LINK_INVALID', 'IMAGE_INVALID', 'BUTTON_LABEL_MISSING']) expect(READINESS_FINDING_CODES).toContain(code);
    for (const code of ['HTML_UNSUPPORTED', 'HTML_MISSING', 'CONDITION_INVALID', 'CONDITIONAL_EMPTY', 'PERSONALIZATION_FIELD_UNKNOWN', 'PERSONALIZATION_FIELD_ARCHIVED']) {
      expect(READINESS_FINDING_CODES).toContain(code);
    }
    expect(new Set(READINESS_FINDING_CODES).size).toBe(READINESS_FINDING_CODES.length);
  });

  it('adds the campaign error codes of contract §15 to the standard error contract, without removing any', () => {
    for (const c of ['validation_failed', 'version_conflict', 'forbidden', 'not_found', 'idempotency_conflict']) expect(API_ERROR_CODES).toContain(c);
    for (const c of ['INVALID_TRANSITION', 'CAMPAIGN_NOT_EDITABLE', 'CAMPAIGN_ACTIVE', 'CHANNEL_NOT_AVAILABLE', 'DELIVERY_NOT_AVAILABLE', 'PREFLIGHT_FAILED', 'PREFLIGHT_UNAVAILABLE']) {
      expect(API_ERROR_CODES).toContain(c);
    }
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
  });
});

describe('campaign.version.v1 snapshot schema (contract §4.1)', () => {
  it('accepts the exact v1 shape', () => {
    expect(campaignVersionSnapshotV1Schema.parse(snapshot())).toEqual(snapshot());
    const now = { ...snapshot(), schedule: { mode: 'now', sendAt: null, timezone: 'UTC' } };
    expect(campaignVersionSnapshotV1Schema.safeParse(now).success).toBe(true);
  });

  const cases: [string, (s: ReturnType<typeof snapshot>) => unknown][] = [
    ['an extra top-level field', (s) => ({ ...s, extra: 1 })],
    ['an extra nested field', (s) => ({ ...s, sender: { ...s.sender, name: 'x' } })],
    ['two topics', (s) => ({ ...s, topic: { ...s.topic, topicIds: [T, T] } })],
    ['a non-UUID topic', (s) => ({ ...s, topic: { ...s.topic, topicIds: ['a'] } })],
    ['a non-UUID selector', (s) => ({ ...s, audience: { include: [{ type: 'list', listId: 'x' }], exclude: [] } })],
    ['an empty include', (s) => ({ ...s, audience: { include: [], exclude: [] } })],
    ['tracking enabled', (s) => ({ ...s, tracking: { opens: true, clicks: false } })],
    ['a subject over 200', (s) => ({ ...s, messages: [{ ...s.messages[0], content: { ...s.messages[0].content, subject: 'x'.repeat(201) } }] })],
    ['an empty subject', (s) => ({ ...s, messages: [{ ...s.messages[0], content: { ...s.messages[0].content, subject: '' } }] })],
    ['a body over 100,000', (s) => ({ ...s, messages: [{ ...s.messages[0], content: { ...s.messages[0].content, body: { format: 'text', text: 'x'.repeat(100_001) } } }] })],
    ['HTML body format', (s) => ({ ...s, messages: [{ ...s.messages[0], content: { ...s.messages[0].content, body: { format: 'html', text: 'x' } } }] })],
    ['a second variant', (s) => ({ ...s, messages: [s.messages[0], { ...s.messages[0] }] })],
    ["mode 'at' without sendAt", (s) => ({ ...s, schedule: { ...s.schedule, sendAt: null } })],
    ["mode 'now' with sendAt", (s) => ({ ...s, schedule: { ...s.schedule, mode: 'now' } })],
    ['a local-offset sendAt (must be the UTC instant)', (s) => ({ ...s, schedule: { ...s.schedule, sendAt: '2026-10-05T03:30:00+05:30' } })],
    ['an A/B test', (s) => ({ ...s, abTest: {} })],
    ['a fromName over 100', (s) => ({ ...s, sender: { ...s.sender, fromName: 'x'.repeat(101) } })],
  ];
  it.each(cases)('rejects %s', (_, mutate) => {
    expect(campaignVersionSnapshotV1Schema.safeParse(mutate(snapshot())).success).toBe(false);
  });
});

describe('findings and pre-flight (contract §3)', () => {
  const finding = { code: 'SUBJECT_MISSING', severity: 'error', section: 'message', field: '/messages/0/content/subject', message: 'Add a subject' };
  it('accepts a finding and rejects unknown codes, non-pointer fields and object-valued details', () => {
    expect(readinessFindingSchema.safeParse(finding).success).toBe(true);
    expect(readinessFindingSchema.safeParse({ ...finding, code: 'SOMETHING_NEW' }).success).toBe(false);
    expect(readinessFindingSchema.safeParse({ ...finding, field: 'subject' }).success).toBe(false);
    expect(readinessFindingSchema.safeParse({ ...finding, details: { contact: { email: 'a@b.c' } } }).success).toBe(false);
    expect(readinessFindingSchema.safeParse({ ...finding, details: { selector: `list:${L}`, estimate: 3 } }).success).toBe(true);
  });

  it('requires every section outcome and bounds the estimate', () => {
    const sections = { details: 'pass', topic: 'pass', audience: 'warning', sender: 'warning', message: 'error', schedule: 'pass', channel: 'pass', delivery: 'error' };
    const ok = {
      readiness: 'not_ready',
      readinessFindings: [finding],
      checkedAt: '2026-10-07T10:00:00.000Z',
      sections,
      estimate: { audienceSize: 120_000, audienceSizeCapped: false, eligibleEstimate: 90_000, sampleSize: 2_000, topReasons: [{ code: 'CONSENT_MISSING', share: 0.2 }] },
    };
    expect(preflightResultSchema.safeParse(ok).success).toBe(true);
    expect(preflightResultSchema.safeParse({ ...ok, estimate: null }).success).toBe(true);
    const { delivery: _omitted, ...partial } = sections;
    expect(preflightResultSchema.safeParse({ ...ok, sections: partial }).success).toBe(false);
    expect(preflightResultSchema.safeParse({ ...ok, estimate: { ...ok.estimate, sampleSize: 2_001 } }).success).toBe(false);
    expect(preflightResultSchema.safeParse({ ...ok, estimate: { ...ok.estimate, audienceSize: 5_000_001 } }).success).toBe(false);
  });
});

describe('campaign event contract v1 (docs/events.md)', () => {
  it('declares exactly the 16 documented types, each with a payload schema', () => {
    expect([...CAMPAIGN_EVENT_TYPES].sort()).toEqual(
      [
        'campaign.created', 'campaign.updated', 'campaign.deleted', 'campaign.restored', 'campaign.version_created', 'campaign.scheduled',
        'campaign.rescheduled', 'campaign.unscheduled', 'campaign.started', 'campaign.audience_materialized', 'campaign.paused',
        'campaign.resumed', 'campaign.cancelled', 'campaign.completed', 'campaign.failed', 'campaign.returned_to_draft',
      ].sort(),
    );
  });

  it('rejects any extra field (no name, subject, body, address or contact id can ride along)', () => {
    for (const type of CAMPAIGN_EVENT_TYPES) {
      for (const leak of ['name', 'subject', 'email', 'contactId']) {
        expect(CAMPAIGN_EVENT_PAYLOAD_SCHEMAS[type].safeParse({ [leak]: 'x' }).success, `${type} + ${leak}`).toBe(false);
      }
    }
    expect(CAMPAIGN_EVENT_PAYLOAD_SCHEMAS['campaign.created'].safeParse({ channel: 'email', clonedFrom: null }).success).toBe(true);
    expect(CAMPAIGN_EVENT_PAYLOAD_SCHEMAS['campaign.deleted'].safeParse({}).success).toBe(true);
  });
});

describe('requests (contract §15)', () => {
  it('create: strict, trimmed, channel enum; workspace never comes from the body', () => {
    expect(createCampaignRequest.parse({ name: '  Launch  ', channel: 'email' })).toEqual({ name: 'Launch', channel: 'email' });
    expect(createCampaignRequest.safeParse({ name: 'x', channel: 'fax' }).success).toBe(false);
    expect(createCampaignRequest.safeParse({ name: '   ', channel: 'email' }).success).toBe(false);
    expect(createCampaignRequest.safeParse({ name: 'x'.repeat(201), channel: 'email' }).success).toBe(false);
    expect(createCampaignRequest.safeParse({ name: 'x', channel: 'email', workspaceId: T }).success).toBe(false);
    // sms/whatsapp are valid wire values; their unavailability is the CHANNEL_NOT_AVAILABLE domain error
    expect(createCampaignRequest.safeParse({ name: 'x', channel: 'sms' }).success).toBe(true);
  });

  it('update: needs expectedVersion and a change; replaces whole fields; findings-level problems are accepted', () => {
    expect(updateCampaignRequest.safeParse({ expectedVersion: 3 }).success).toBe(false);
    expect(updateCampaignRequest.safeParse({ name: 'x' }).success).toBe(false);
    expect(updateCampaignRequest.safeParse({ expectedVersion: 0, name: 'x' }).success).toBe(false);
    expect(updateCampaignRequest.safeParse({ expectedVersion: 1.5, name: 'x' }).success).toBe(false);
    const many = Array.from({ length: 26 }, (_, i) => ({ type: 'list' as const, listId: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}` }));
    // > 25 sources and an include/exclude overlap are readiness findings, not request errors
    expect(updateCampaignRequest.safeParse({ expectedVersion: 1, audience: { include: many, exclude: [many[0]] } }).success).toBe(true);
    expect(updateCampaignRequest.safeParse({ expectedVersion: 1, audience: { include: [many[0], many[0]], exclude: [] } }).success).toBe(false);
    const tooMany = Array.from({ length: 101 }, (_, i) => ({ type: 'tag' as const, tagId: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}` }));
    expect(updateCampaignRequest.safeParse({ expectedVersion: 1, audience: { include: tooMany, exclude: [] } }).success).toBe(false);
    const content = (subject: string, preheader = '') => ({ schema: 'email.content.v1', subject, preheader, body: { format: 'text', text: '' } });
    expect(updateCampaignRequest.safeParse({ expectedVersion: 1, messages: [{ variantKey: 'default', content: content('x'.repeat(250)) }] }).success).toBe(true);
    expect(updateCampaignRequest.safeParse({ expectedVersion: 1, messages: [{ variantKey: 'default', content: content('s', 'x'.repeat(201)) }] }).success).toBe(false);
    expect(updateCampaignRequest.safeParse({ expectedVersion: 1, messages: [{ variantKey: 'b', content: content('s') }] }).success).toBe(false);
    const sender = updateCampaignRequest.parse({ expectedVersion: 1, sender: { senderIdentityId: null, fromName: '  ', replyTo: 'not-an-email' } });
    expect(sender.sender).toEqual({ senderIdentityId: null, fromName: null, replyTo: 'not-an-email' });
    expect(updateCampaignRequest.safeParse({ expectedVersion: 1, schedule: { mode: 'at', sendAt: '2026-10-05 10:00', timezone: 'UTC' } }).success).toBe(false);
    expect(updateCampaignRequest.safeParse({ expectedVersion: 1, schedule: { mode: 'at', sendAt: '2026-10-05T10:00:00+05:30', timezone: 'Not/AZone' } }).success).toBe(true);
  });

  it('schedule / send-now / reschedule / clone', () => {
    expect(scheduleCampaignRequest.safeParse({ mode: 'now', expectedVersion: 2 }).success).toBe(true);
    expect(scheduleCampaignRequest.safeParse({ mode: 'now', sendAt: '2026-10-05T10:00:00Z', expectedVersion: 2 }).success).toBe(false);
    expect(scheduleCampaignRequest.safeParse({ mode: 'at', expectedVersion: 2 }).success).toBe(false);
    expect(scheduleCampaignRequest.safeParse({ mode: 'at', sendAt: '2026-10-05T10:00:00+05:30', timezone: 'Asia/Kolkata', expectedVersion: 2 }).success).toBe(true);
    expect(scheduleCampaignRequest.safeParse({ mode: 'at', sendAt: '2026-10-05T10:00:00Z' }).success).toBe(false);
    expect(rescheduleCampaignRequest.safeParse({ sendAt: '2026-10-05T10:00:00Z', expectedVersion: 2 }).success).toBe(true);
    expect(cloneCampaignRequest.safeParse({}).success).toBe(true);
    expect(cloneCampaignRequest.safeParse({ versionId: 'v1' }).success).toBe(false);
  });

  it('list and recipients queries', () => {
    expect(campaignListQuery.parse({}).limit).toBe(25);
    expect(campaignListQuery.parse({ status: 'draft' }).status).toEqual(['draft']);
    expect(campaignListQuery.parse({ status: ['draft', 'failed', 'draft'] }).status).toEqual(['draft', 'failed']);
    expect(campaignListQuery.safeParse({ status: 'pending_approval' }).success).toBe(false);
    expect(campaignListQuery.safeParse({ q: 'a' }).success).toBe(false);
    expect(campaignListQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(campaignListQuery.parse({ deleted: 'only', limit: '10' })).toMatchObject({ deleted: 'only', limit: 10 });
    expect(campaignRecipientsQuery.safeParse({ reason: 'CONSENT_MISSING' }).success).toBe(true);
    expect(campaignRecipientsQuery.safeParse({ reason: "x' OR 1=1" }).success).toBe(false);
  });
});

describe('views (contract §15)', () => {
  const view = {
    id: T,
    name: 'Launch',
    description: '',
    channel: 'email',
    purpose: 'marketing',
    status: 'draft',
    version: 1,
    deletedAt: null,
    draft: {
      topicId: null,
      audience: { include: [], exclude: [] },
      sender: { senderIdentityId: null, fromName: null, replyTo: null },
      messages: [],
      schedule: { mode: 'now', sendAt: null, timezone: 'UTC' },
    },
    currentVersion: null,
    currentExecution: null,
    allowedActions: ['update', 'clone', 'delete'],
    blockedActions: [{ action: 'schedule', reason: 'DELIVERY_NOT_AVAILABLE' }],
    readiness: 'not_ready',
    readinessFindings: [],
    createdAt: '2026-10-07T10:00:00.000Z',
    updatedAt: '2026-10-07T10:00:00.000Z',
    createdBy: null,
  };

  it('CampaignView is exact (no undeclared field can leak)', () => {
    expect(campaignViewSchema.safeParse(view).success).toBe(true);
    expect(campaignViewSchema.safeParse({ ...view, orgId: T }).success).toBe(false);
    expect(campaignViewSchema.safeParse({ ...view, status: 'stopped' }).success).toBe(false);
  });

  it('counts cover every status; capabilities report only the three known modes; version detail carries a valid snapshot', () => {
    expect(campaignCountsByStatusSchema.safeParse({ draft: 1, scheduled: 0, sending: 0, paused: 0, completed: 0, cancelled: 0 }).success).toBe(false);
    // Owner-authorized 2026-10-09: live is a mode (off unless configured); anything else is still refused.
    expect(campaignCapabilitiesSchema.safeParse({ deliveryMode: 'live', channels: [] }).success).toBe(true);
    expect(campaignCapabilitiesSchema.safeParse({ deliveryMode: 'enabled', channels: [] }).success).toBe(false);
    expect(campaignCapabilitiesSchema.safeParse({ deliveryMode: 'disabled', channels: [{ channel: 'email', enabled: true, sendingAvailable: false }] }).success).toBe(true);
    const detail = { id: T, number: 1, reason: 'scheduled', contentHash: 'a'.repeat(64), createdAt: '2026-10-07T10:00:00.000Z', createdBy: null, snapshot: snapshot() };
    expect(versionDetailSchema.safeParse(detail).success).toBe(true);
    expect(versionDetailSchema.safeParse({ ...detail, snapshot: { ...snapshot(), abTest: {} } }).success).toBe(false);
    expect(pageOf(versionDetailSchema).safeParse({ data: [detail], nextCursor: null }).success).toBe(true);
  });
});
