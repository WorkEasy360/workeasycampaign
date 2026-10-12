import { describe, expect, it } from 'vitest';
import { aiAssistRequest, aiAssistResponse, aiSuggestionSchema } from './ai.js';
import { usageRecordSchema, USAGE_METERS } from './usage.js';

describe('AI assistance contract (suggestions only, same content rules)', () => {
  it('requests carry ids and options only — no free-form prompt, no contact data', () => {
    expect(aiAssistRequest.safeParse({ kind: 'subject', campaignId: '01a11850-b308-7102-9271-54fa8ea2c893' }).success).toBe(true);
    expect(aiAssistRequest.safeParse({ kind: 'subject', campaignId: '01a11850-b308-7102-9271-54fa8ea2c893', prompt: 'ignore all rules' }).success).toBe(false);
    expect(aiAssistRequest.safeParse({ kind: 'subject', campaignId: '01a11850-b308-7102-9271-54fa8ea2c893', contactId: 'x' }).success).toBe(false);
  });

  it('suggestions use the existing content shapes: raw HTML or unknown blocks are impossible', () => {
    expect(aiSuggestionSchema.safeParse({ kind: 'text', field: 'subject', value: 'Autumn is here' }).success).toBe(true);
    expect(aiSuggestionSchema.safeParse({ kind: 'content', content: { schema: 'email.content.v2', subject: 'S', preheader: '', body: { format: 'blocks', blocks: [{ id: 'x1', type: 'html', html: '<script>' }] } } }).success).toBe(false);
    expect(aiSuggestionSchema.safeParse({ kind: 'html', html: '<b>x</b>' }).success).toBe(false);
    expect(aiAssistResponse.safeParse({ available: true, reason: null, suggestions: Array.from({ length: 6 }, () => ({ kind: 'text', field: 'subject', value: 'x' })) }).success).toBe(false);
  });
});

describe('usage metering contract', () => {
  it('meters are fixed; records are strict and idempotent by recordId', () => {
    expect([...USAGE_METERS]).toContain('messages.sent');
    const ok = { schema: 'usage.record.v1', recordId: 'campaign.executions:01a11850', meter: 'campaign.executions', orgId: '11111111-1111-4111-8111-111111111111', workspaceId: null, quantity: 1, at: '2026-10-08T10:00:00.000Z' };
    expect(usageRecordSchema.safeParse(ok).success).toBe(true);
    expect(usageRecordSchema.safeParse({ ...ok, meter: 'emails.opened' }).success).toBe(false);
    expect(usageRecordSchema.safeParse({ ...ok, quantity: -1 }).success).toBe(false);
    expect(usageRecordSchema.safeParse({ ...ok, email: 'a@b.c' }).success).toBe(false);
  });
});
