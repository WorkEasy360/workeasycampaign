import type { CampaignListItem, CampaignView, ExecutionSummary, Permission, PreflightResult } from '@workeasy/shared';
import { VIEWER } from './audience';

export const CAMPAIGN_VIEWER: Permission[] = [...VIEWER, 'campaigns.read'];
export const CAMPAIGN_EDITOR: Permission[] = [...CAMPAIGN_VIEWER, 'campaigns.create', 'campaigns.update', 'campaigns.delete'];
export const CAMPAIGN_MANAGER: Permission[] = [...CAMPAIGN_EDITOR, 'campaigns.send'];

export const LIST_ID = '22222222-2222-4222-8222-222222222222';
export const TOPIC_ID = '33333333-3333-4333-8333-333333333333';

export const capabilities = (mode: 'disabled' | 'test' | 'live' = 'test') => ({
  deliveryMode: mode,
  channels: [
    { channel: 'email', enabled: true, sendingAvailable: mode !== 'disabled' },
    { channel: 'sms', enabled: false, sendingAvailable: false },
    { channel: 'whatsapp', enabled: false, sendingAvailable: false },
  ],
});

export const execution = (over: Partial<ExecutionSummary> = {}): ExecutionSummary => ({
  id: 'e1',
  runNumber: 1,
  status: 'delivering',
  health: 'ok',
  sendAt: '2026-10-08T09:00:00.000Z',
  startedAt: '2026-10-08T09:00:01.000Z',
  materializedAt: '2026-10-08T09:00:05.000Z',
  completedAt: null,
  lastProgressAt: '2026-10-08T09:00:06.000Z',
  counts: { planned: 800, skipped: 200, sent: 300, failed: 0, cancelled: 0, unknown: 0 },
  skippedByReason: { CONSENT_MISSING: 150, SUPPRESSED: 50 },
  failure: null,
  maxPerHour: null,
  ...over,
});

export function campaignView(over: Partial<CampaignView> = {}): CampaignView {
  return {
    id: 'c1',
    name: 'Autumn sale',
    description: '',
    channel: 'email',
    purpose: 'marketing',
    status: 'draft',
    version: 3,
    deletedAt: null,
    draft: {
      topicId: TOPIC_ID,
      audience: { include: [{ type: 'list', listId: LIST_ID }], exclude: [] },
      sender: { senderIdentityId: null, fromName: 'Acme', replyTo: null },
      messages: [{ variantKey: 'default', content: { schema: 'email.content.v1', subject: 'Hello', preheader: '', body: { format: 'text', text: 'Body' } } }],
      schedule: { mode: 'now', sendAt: null, timezone: 'UTC' },
    },
    currentVersion: null,
    currentExecution: null,
    allowedActions: ['update', 'schedule', 'send_now', 'clone', 'delete'],
    blockedActions: [],
    readiness: 'ready',
    readinessFindings: [{ code: 'SENDER_NOT_CONFIGURED', severity: 'warning', section: 'sender', field: '/sender/senderIdentityId', message: 'Verified sender identities arrive with delivery' }],
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-07T10:00:00.000Z',
    createdBy: { id: 'u1', displayName: 'Sam' },
    ...over,
  };
}

export const listItem = (over: Partial<CampaignListItem> = {}): CampaignListItem => ({
  id: 'c1',
  name: 'Autumn sale',
  channel: 'email',
  status: 'draft',
  version: 3,
  deletedAt: null,
  topicId: TOPIC_ID,
  currentExecution: null,
  readiness: 'ready',
  allowedActions: ['update'],
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-07T10:00:00.000Z',
  ...over,
});

export const counts = { draft: 2, scheduled: 1, sending: 1, paused: 1, completed: 4, cancelled: 0, failed: 0 };

const sections = { details: 'pass', topic: 'pass', audience: 'pass', sender: 'warning', message: 'pass', schedule: 'pass', channel: 'pass', delivery: 'pass' } as const;

export const preflight = (over: Partial<PreflightResult> = {}): PreflightResult => ({
  readiness: 'ready',
  readinessFindings: [],
  checkedAt: '2026-10-07T10:00:00.000Z',
  sections,
  estimate: { audienceSize: 1_000, audienceSizeCapped: false, eligibleEstimate: 800, sampleSize: 1_000, topReasons: [{ code: 'CONSENT_MISSING', share: 0.2 }] },
  ...over,
});

export const unavailablePreflight = (): PreflightResult =>
  preflight({
    readiness: 'not_ready',
    estimate: null,
    sections: { ...sections, audience: 'error' },
    readinessFindings: [
      { code: 'ELIGIBILITY_ESTIMATE_UNAVAILABLE', severity: 'error', section: 'audience', field: '/audience', message: 'The audience size and eligibility estimate are being prepared. Try again shortly.', details: { retryAfterSeconds: 30 } },
    ],
  });
