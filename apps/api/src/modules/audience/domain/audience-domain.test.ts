import { describe, expect, it } from 'vitest';
import { canChangeSubscription, effectiveChannelState, evidenceProblems, nextChannelState, nextTopicState } from './consent.js';
import { definitionProblems, type FieldDefinition, validateFieldValue } from './custom-fields.js';
import { evaluateEligibility, type EligibilityFacts } from './eligibility.js';
import { csvSafe, decideRow, suggestMapping } from './import-decision.js';
import { buildSearchText, normalizeEmail, normalizeIdentity, normalizePhone } from './normalization.js';

describe('identity normalization', () => {
  it('normalizes email deterministically (trim, NFC, lower-case) without folding dots or plus tags', () => {
    expect(normalizeEmail('  Ann.Lee+news@Example.COM ')).toMatchObject({ ok: true, normalized: 'ann.lee+news@example.com' });
    // The display value keeps what the person typed; only the normalized key must agree.
    const a = normalizeEmail('ANN@example.com');
    const b = normalizeEmail('ann@EXAMPLE.com');
    expect(a.ok && b.ok && a.normalized === b.normalized).toBe(true);
  });
  it.each(['not-an-email', 'a@b', 'a b@c.com', 'a@@b.com', 'a..b@c.com', `${'x'.repeat(250)}@a.com`])('rejects %s', (v) => {
    expect(normalizeEmail(v).ok).toBe(false);
  });
  it('normalizes phones to E.164 from international or national formats', () => {
    expect(normalizePhone('+91 98765 43210')).toMatchObject({ ok: true, normalized: '+919876543210' });
    expect(normalizePhone('0091 98765-43210')).toMatchObject({ ok: true, normalized: '+919876543210' });
    expect(normalizePhone('098765 43210', 'IN')).toMatchObject({ ok: true, normalized: '+919876543210' });
    expect(normalizePhone('(415) 555-2671', 'US')).toMatchObject({ ok: true, normalized: '+14155552671' });
  });
  it('never guesses a country and rejects invalid numbers', () => {
    expect(normalizePhone('98765 43210')).toMatchObject({ ok: false, code: 'COUNTRY_REQUIRED' });
    expect(normalizePhone('+1 123')).toMatchObject({ ok: false, code: 'INVALID_PHONE' });
  });
  it('treats WhatsApp ids as phone numbers and keeps external ids case-sensitive', () => {
    expect(normalizeIdentity('whatsapp', '+44 7911 123456')).toMatchObject({ normalized: '+447911123456' });
    expect(normalizeIdentity('external', ' CRM-ABC ')).toMatchObject({ normalized: 'CRM-ABC' });
  });
  it('builds lower-case search text from names and identities', () => {
    expect(buildSearchText({ firstName: 'Ann', lastName: 'Lee', company: null }, [{ valueNormalized: 'ann@x.io' }])).toBe('ann lee ann@x.io');
  });
});

const field = (type: FieldDefinition['type'], extra: Partial<FieldDefinition> = {}): FieldDefinition => ({
  key: 'f',
  label: 'Field',
  type,
  required: false,
  status: 'active',
  options: [],
  validation: {},
  ...extra,
});

describe('custom field validation', () => {
  it.each([
    ['text', 'hello', 'hello'],
    ['number', '1,200', 1200],
    ['decimal', '3.14', 3.14],
    ['boolean', 'Yes', true],
    ['boolean', false, false],
    ['date', '2026-02-28', '2026-02-28'],
    ['datetime', '2026-02-28T10:00:00+05:30', '2026-02-28T04:30:00.000Z'],
    ['email', 'A@B.co', 'a@b.co'],
    ['phone', '+91 98765 43210', '+919876543210'],
    ['url', 'https://example.com/x', 'https://example.com/x'],
  ] as const)('accepts and normalizes %s %j', (type, raw, expected) => {
    expect(validateFieldValue(field(type), raw)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ['number', '1.5'],
    ['decimal', '1.1234567'],
    ['boolean', 'maybe'],
    ['date', '2026-02-30'],
    ['datetime', '2026-02-28 10:00'],
    ['url', 'javascript:alert(1)'],
    ['url', 'data:text/html,hi'],
    ['email', 'nope'],
  ] as const)('rejects %s %j', (type, raw) => {
    expect(validateFieldValue(field(type), raw).ok).toBe(false);
  });

  it('enforces length and range rules', () => {
    expect(validateFieldValue(field('text', { validation: { maxLength: 3 } }), 'abcd').ok).toBe(false);
    expect(validateFieldValue(field('number', { validation: { min: 1, max: 5 } }), 9).ok).toBe(false);
  });

  it('matches select options by key or label and ignores archived options', () => {
    const def = field('multi_select', {
      options: [
        { key: 'gold', label: 'Gold', archived: false },
        { key: 'old', label: 'Old', archived: true },
      ],
    });
    expect(validateFieldValue(def, 'gold;GOLD')).toEqual({ ok: true, value: ['gold'] });
    expect(validateFieldValue(def, 'Old').ok).toBe(false);
  });

  it('strips control characters from untrusted text', () => {
    expect(validateFieldValue(field('text'), 'a\u0000b\u0007c')).toEqual({ ok: true, value: 'abc' });
  });

  it('validates definitions: reserved keys, options only for selects, archived not required', () => {
    expect(definitionProblems({ key: 'email', type: 'text', options: [], required: false, status: 'active' })).toContain('"email" is reserved');
    expect(definitionProblems({ key: 'tier', type: 'single_select', options: [], required: false, status: 'active' })).toContain('Add at least one option');
    expect(definitionProblems({ key: 'x', type: 'text', options: [], required: true, status: 'archived' })).toContain('An archived field cannot be required');
  });
});

describe('consent state machine', () => {
  it('grants, confirms double opt-in and withdraws', () => {
    expect(nextChannelState('none', null, 'subscribed', 'user')).toEqual({ ok: true, newState: 'granted' });
    expect(nextChannelState('none', null, 'pending', 'user')).toEqual({ ok: true, newState: 'pending' });
    expect(nextChannelState('pending', 'user', 'confirmed', 'contact')).toEqual({ ok: true, newState: 'granted' });
    expect(nextChannelState('granted', 'user', 'unsubscribed', 'contact')).toEqual({ ok: true, newState: 'withdrawn' });
    expect(nextChannelState('granted', 'user', 'revoked', 'user')).toEqual({ ok: true, newState: 'withdrawn' });
  });

  it('refuses to confirm anything that is not pending, and reports no-ops', () => {
    expect(nextChannelState('none', null, 'confirmed', 'contact')).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    expect(nextChannelState('granted', 'user', 'subscribed', 'user')).toMatchObject({ ok: false, code: 'NO_CHANGE' });
  });

  it('a contact’s own withdrawal cannot be reversed by staff, only by the contact', () => {
    expect(nextChannelState('withdrawn', 'contact', 'subscribed', 'user')).toMatchObject({ ok: false, code: 'SELF_UNSUBSCRIBED' });
    expect(nextChannelState('withdrawn', 'contact', 'pending', 'api_key')).toMatchObject({ ok: false, code: 'SELF_UNSUBSCRIBED' });
    expect(nextChannelState('withdrawn', 'contact', 'subscribed', 'contact')).toEqual({ ok: true, newState: 'granted' });
    expect(nextChannelState('withdrawn', 'user', 'subscribed', 'user')).toEqual({ ok: true, newState: 'granted' });
  });

  it('applies the same rule to topics and to the subscription type', () => {
    expect(nextTopicState('unsubscribed', 'contact', 'subscribed', 'user')).toMatchObject({ code: 'SELF_UNSUBSCRIBED' });
    expect(nextTopicState('none', null, 'subscribed', 'user')).toEqual({ ok: true, newState: 'subscribed' });
    expect(canChangeSubscription('unsubscribed', 'contact', 'marketing', 'user')).toMatchObject({ code: 'SELF_UNSUBSCRIBED' });
    expect(canChangeSubscription('unsubscribed', 'user', 'marketing', 'user')).toEqual({ ok: true, newState: 'marketing' });
  });

  it('requires evidence when staff record a grant', () => {
    expect(evidenceProblems('subscribed', 'user', undefined, undefined, undefined)).toHaveLength(2);
    expect(evidenceProblems('subscribed', 'user', 'consent', 'Signed form at event', undefined)).toEqual([]);
    expect(evidenceProblems('unsubscribed', 'user', undefined, undefined, undefined)).toEqual([]);
  });

  it('records an explicit unsubscribe even when nothing was granted, so the opt-out is evidence and sticky', () => {
    expect(nextChannelState('none', null, 'unsubscribed', 'contact')).toEqual({ ok: true, newState: 'withdrawn' });
    // ...and once the contact said no themselves, staff cannot grant for them.
    expect(nextChannelState('withdrawn', 'contact', 'subscribed', 'user')).toMatchObject({ code: 'SELF_UNSUBSCRIBED' });
    // A staff "revoke" with nothing to revoke stays a no-op.
    expect(nextChannelState('none', null, 'revoked', 'user')).toMatchObject({ code: 'NO_CHANGE' });
  });

  it('pending consent expires after the policy period, measured from server time', () => {
    const recorded = new Date('2026-01-01T00:00:00Z');
    expect(effectiveChannelState('pending', recorded, 7, new Date('2026-01-07T23:59:00Z'))).toBe('pending');
    expect(effectiveChannelState('pending', recorded, 7, new Date('2026-01-08T00:01:00Z'))).toBe('expired');
    expect(effectiveChannelState('granted', recorded, 7, new Date('2027-01-01T00:00:00Z'))).toBe('granted');
  });

  it('an expired request cannot be confirmed; a new request or a grant starts over', () => {
    expect(nextChannelState('expired', 'user', 'confirmed', 'contact')).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    expect(nextChannelState('expired', 'user', 'pending', 'user')).toEqual({ ok: true, newState: 'pending' });
    expect(nextChannelState('expired', 'user', 'subscribed', 'contact')).toEqual({ ok: true, newState: 'granted' });
    expect(nextChannelState('expired', 'user', 'unsubscribed', 'contact')).toEqual({ ok: true, newState: 'withdrawn' });
  });
});

const facts = (over: Partial<EligibilityFacts> = {}): EligibilityFacts => ({
  contact: { id: 'c', deleted: false, erased: false, subscriptionType: 'marketing' },
  addresses: ['a@b.co'],
  suppressions: [],
  consent: { state: 'granted', forCurrentAddress: true },
  ...over,
});
const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

describe('eligibility engine', () => {
  it('a marketing contact with an address, consent and no suppression is eligible', () => {
    expect(evaluateEligibility(facts(), { channel: 'email', purpose: 'marketing', topicId: null })).toEqual({ eligible: true, reasons: [] });
  });

  it('reports every failing check, most fundamental first', () => {
    const r = evaluateEligibility(
      facts({ contact: { id: 'c', deleted: false, erased: false, subscriptionType: 'unsubscribed' }, suppressions: [{ channel: 'all', reason: 'manual' }], consent: { state: 'none', forCurrentAddress: true }, topic: { status: 'active', preference: 'none' } }),
      { channel: 'email', purpose: 'marketing', topicId: 't' },
    );
    expect(r.eligible).toBe(false);
    expect(codes(r)).toEqual(['UNSUBSCRIBED', 'SUPPRESSED', 'CONSENT_MISSING', 'TOPIC_NOT_SUBSCRIBED']);
  });

  it('suppression applies to its channel and to "all", not to other channels', () => {
    const sms = facts({ suppressions: [{ channel: 'sms', reason: 'manual' }] });
    expect(codes(evaluateEligibility(sms, { channel: 'sms', purpose: 'marketing', topicId: null }))).toEqual(['SUPPRESSED']);
    expect(evaluateEligibility(sms, { channel: 'email', purpose: 'marketing', topicId: null }).eligible).toBe(true);
  });

  it('transactional messages skip marketing checks but never suppression', () => {
    const f = facts({ contact: { id: 'c', deleted: false, erased: false, subscriptionType: 'unsubscribed' }, consent: { state: 'withdrawn', forCurrentAddress: true } });
    expect(evaluateEligibility(f, { channel: 'email', purpose: 'transactional', topicId: null }).eligible).toBe(true);
    const suppressed = facts({ suppressions: [{ channel: 'email', reason: 'compliance' }] });
    expect(codes(evaluateEligibility(suppressed, { channel: 'email', purpose: 'transactional', topicId: null }))).toEqual(['SUPPRESSED']);
  });

  it('deleted contacts, missing addresses, pending/withdrawn consent and archived topics are reported', () => {
    expect(codes(evaluateEligibility(facts({ contact: { id: 'c', deleted: true, erased: false, subscriptionType: 'marketing' } }), { channel: 'email', purpose: 'marketing', topicId: null }))).toEqual(['CONTACT_DELETED']);
    expect(codes(evaluateEligibility(facts({ addresses: [] }), { channel: 'sms', purpose: 'marketing', topicId: null }))).toEqual(['NO_ADDRESS']);
    expect(codes(evaluateEligibility(facts({ consent: { state: 'pending', forCurrentAddress: true } }), { channel: 'email', purpose: 'marketing', topicId: null }))).toEqual(['CONSENT_PENDING']);
    expect(codes(evaluateEligibility(facts({ consent: { state: 'withdrawn', forCurrentAddress: true } }), { channel: 'email', purpose: 'marketing', topicId: null }))).toEqual(['CONSENT_WITHDRAWN']);
    expect(codes(evaluateEligibility(facts({ topic: { status: 'archived', preference: 'subscribed' } }), { channel: 'email', purpose: 'marketing', topicId: 't' }))).toEqual(['TOPIC_INACTIVE']);
  });

  it('consent given for another address does not count; an expired request never qualifies', () => {
    const m = { channel: 'email', purpose: 'marketing', topicId: null } as const;
    expect(codes(evaluateEligibility(facts({ consent: { state: 'granted', forCurrentAddress: false } }), m))).toEqual(['CONSENT_ADDRESS_CHANGED']);
    expect(codes(evaluateEligibility(facts({ consent: { state: 'expired', forCurrentAddress: true } }), m))).toEqual(['CONSENT_EXPIRED']);
    // A withdrawal blocks every address of the channel, whichever address it was made for.
    expect(codes(evaluateEligibility(facts({ consent: { state: 'withdrawn', forCurrentAddress: false } }), m))).toEqual(['CONSENT_WITHDRAWN']);
    // Transactional messages do not depend on marketing consent.
    expect(evaluateEligibility(facts({ consent: { state: 'granted', forCurrentAddress: false } }), { ...m, purpose: 'transactional' }).eligible).toBe(true);
  });
});

describe('import duplicate decisions', () => {
  const m = (kind: 'email' | 'phone', contactId: string | null, contactDeleted = false) => ({ kind, contactId, contactDeleted });
  it('creates new contacts and updates existing ones per mode', () => {
    expect(decideRow('create_or_update', [m('email', null)], false)).toEqual({ action: 'create' });
    expect(decideRow('create_or_update', [m('email', 'c1'), m('phone', null)], false)).toEqual({ action: 'update', contactId: 'c1' });
    expect(decideRow('create_only', [m('email', 'c1')], false)).toMatchObject({ action: 'skip', code: 'EXISTS' });
    expect(decideRow('update_only', [m('email', null)], false)).toMatchObject({ action: 'skip', code: 'NOT_FOUND' });
  });
  it('never merges: email and phone owned by different contacts is a conflict', () => {
    expect(decideRow('create_or_update', [m('email', 'c1'), m('phone', 'c2')], false)).toMatchObject({ action: 'error', code: 'IDENTITY_CONFLICT' });
  });
  it('rows matching deleted contacts, duplicate rows and rows without identities are not imported', () => {
    expect(decideRow('create_or_update', [m('email', 'c1', true)], false)).toMatchObject({ action: 'error', code: 'CONTACT_DELETED' });
    expect(decideRow('create_or_update', [m('email', null)], true)).toMatchObject({ action: 'skip', code: 'DUPLICATE_IN_FILE' });
    expect(decideRow('create_or_update', [], false)).toMatchObject({ action: 'error', code: 'NO_IDENTITY' });
  });
  it('suggests mappings from common headers and custom-field labels, each target once', () => {
    expect(suggestMapping(['E-mail', 'First Name', 'Mobile', 'Plan', 'email'], [{ key: 'plan', label: 'Plan', status: 'active' }])).toEqual({
      0: 'email', 1: 'first_name', 2: 'phone', 3: 'cf:plan', 4: 'ignore',
    });
  });
  it('neutralizes spreadsheet formulas in CSV output', () => {
    expect(csvSafe('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvSafe('+1 555')).toBe("'+1 555");
    expect(csvSafe('plain')).toBe('plain');
  });
});
