import { describe, expect, it } from 'vitest';
import { canonicalSms, canonicalWhatsApp, mergeFieldsUsedMessaging, renderSms, renderWhatsAppVariables, SMS_OPT_OUT_INSTRUCTION, smsIssues, smsSegments, whatsappIssues } from './messaging.js';

const data = { 'contact.first_name': 'Ann', 'contact.custom.city': 'Pune', 'workspace.name': 'Main', 'organization.name': 'Acme' };

describe('SMS content (messaging amendment)', () => {
  it('requires a body, checks merge tags and the length INCLUDING the appended opt-out instruction', () => {
    expect(smsIssues({ schema: 'sms.content.v1', text: '  ' })).toEqual([{ code: 'BODY_MISSING', pointer: '/text', message: 'Write the message' }]);
    expect(smsIssues({ schema: 'sms.content.v1', text: 'Hi {{ contact.nope }}' }).map((i) => i.code)).toEqual(['MERGE_TAG_INVALID']);
    expect(smsIssues({ schema: 'sms.content.v1', text: 'x'.repeat(1590) }).map((i) => i.code)).toEqual(['BODY_TOO_LONG']);
    expect(smsIssues({ schema: 'sms.content.v1', text: `${'x'.repeat(1590)} STOP` })).toEqual([]);
    expect(canonicalSms({ schema: 'sms.content.v1', text: '  Hi {{ contact.first_name | "there" }}  ' })).toEqual({ schema: 'sms.content.v1', text: 'Hi {{ contact.first_name | "there" }}' });
    expect(canonicalSms({ schema: 'sms.content.v1', text: '' })).toBeNull();
  });

  it('renders personalized text and always ends with an opt-out instruction (never twice)', () => {
    expect(renderSms({ schema: 'sms.content.v1', text: 'Hi {{ contact.first_name }} from {{ organization.name }}' }, data)).toBe(`Hi Ann from Acme\n${SMS_OPT_OUT_INSTRUCTION}`);
    expect(renderSms({ schema: 'sms.content.v1', text: 'Sale! Text STOP to unsubscribe' }, data)).toBe('Sale! Text STOP to unsubscribe');
    expect(renderSms({ schema: 'sms.content.v1', text: 'Hi {{ contact.last_name | "friend" }}' }, data)).toBe(`Hi friend\n${SMS_OPT_OUT_INSTRUCTION}`);
  });

  it('counts segments by encoding (GSM-7 160/153, UCS-2 70/67)', () => {
    expect(smsSegments('')).toMatchObject({ segments: 0 });
    expect(smsSegments('a'.repeat(160))).toEqual({ encoding: 'GSM-7', characters: 160, segments: 1 });
    expect(smsSegments('a'.repeat(161))).toEqual({ encoding: 'GSM-7', characters: 161, segments: 2 });
    expect(smsSegments('€'.repeat(80))).toEqual({ encoding: 'GSM-7', characters: 160, segments: 1 });
    expect(smsSegments('🙂'.repeat(70))).toEqual({ encoding: 'UCS-2', characters: 70, segments: 1 });
    expect(smsSegments('🙂'.repeat(71))).toMatchObject({ encoding: 'UCS-2', segments: 2 });
  });
});

describe('WhatsApp content (approved templates)', () => {
  const draft = (name: string, language: string, parameters: string[]) => ({ schema: 'whatsapp.content.v1' as const, template: { name, language, parameters } });

  it('requires a template name and language in Meta\'s formats; every parameter must be filled', () => {
    expect(whatsappIssues(draft('', '', [])).map((i) => i.code)).toEqual(['TEMPLATE_MISSING', 'TEMPLATE_MISSING']);
    expect(whatsappIssues(draft('Spring Sale', 'english', [])).map((i) => [i.code, i.pointer])).toEqual([
      ['TEMPLATE_INVALID', '/template/name'],
      ['TEMPLATE_INVALID', '/template/language'],
    ]);
    expect(whatsappIssues(draft('spring_sale', 'en_US', ['', '{{ contact.zzz }}'])).map((i) => [i.code, i.pointer])).toEqual([
      ['TEMPLATE_INVALID', '/template/parameters/0'],
      ['MERGE_TAG_INVALID', '/template/parameters/1'],
    ]);
    expect(canonicalWhatsApp(draft(' spring_sale ', 'en_US', [' {{ contact.first_name }} ']))).toEqual({ schema: 'whatsapp.content.v1', template: { name: 'spring_sale', language: 'en_US', parameters: ['{{ contact.first_name }}'] } });
  });

  it('renders variables {{1}}…{{n}} in order; an empty value becomes "-" (Meta rejects empty parameters)', () => {
    const c = { schema: 'whatsapp.content.v1' as const, template: { name: 'spring_sale', language: 'en', parameters: ['{{ contact.first_name }}', '{{ contact.custom.city }}', '{{ contact.last_name }}'] } };
    expect(renderWhatsAppVariables(c, data)).toEqual({ '1': 'Ann', '2': 'Pune', '3': '-' });
    expect(mergeFieldsUsedMessaging(c)).toEqual(['contact.first_name', 'contact.custom.city', 'contact.last_name']);
  });
});
