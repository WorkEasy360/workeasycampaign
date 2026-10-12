'use client';

import { renderSms, renderWhatsAppVariables, SMS_OPT_OUT_INSTRUCTION, smsSegments } from '@workeasy/content';
import { EXAMPLE_MERGE_DATA_V2, SMS_CONTENT_LIMITS, type SmsContentDraft, WHATSAPP_CONTENT_LIMITS, type WhatsAppContentDraft } from '@workeasy/shared';
import { Plus, Trash2 } from 'lucide-react';
import { Alert, Button, Field, Input } from '@/components/ui';

const control =
  'w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:bg-surface-muted aria-invalid:border-danger';

/** Fields of the messaging editors, for focusing a server finding (draft editor FIELD_ID). */
export const MESSAGING_FIELD_ID = {
  '/messages/0/content/text': 'campaign-sms-text',
  '/messages/0/content/template/name': 'campaign-wa-template',
  '/messages/0/content/template/language': 'campaign-wa-language',
} as const;

/**
 * SMS message (messaging amendment): one text with merge fields. Shows exactly what is sent to the example contact —
 * including the STOP instruction added when the text has none — and how many segments the carrier bills.
 */
export function SmsMessageEditor({ value, disabled, onChange, errors }: { value: SmsContentDraft; disabled: boolean; onChange: (v: SmsContentDraft) => void; errors: Record<string, string[] | undefined> }) {
  const rendered = value.text.trim() ? renderSms({ schema: 'sms.content.v1', text: value.text.trim() }, EXAMPLE_MERGE_DATA_V2) : '';
  const seg = smsSegments(rendered);
  return (
    <div className="space-y-4">
      <Field id={MESSAGING_FIELD_ID['/messages/0/content/text']} label="Text message" errors={errors['messages.0.content.text']} hint={'Personal fields work as in email, e.g. {{ contact.first_name | "there" }}.'}>
        {(p) => (
          <textarea {...p} className={`${control} min-h-32`} value={value.text} disabled={disabled} maxLength={SMS_CONTENT_LIMITS.text} onChange={(e) => onChange({ schema: 'sms.content.v1', text: e.target.value })} />
        )}
      </Field>
      <div className="rounded-control border border-line bg-surface-muted p-3" aria-live="polite">
        <p className="text-xs font-medium text-ink-muted">What the example contact receives</p>
        <p className="mt-1 whitespace-pre-wrap text-sm">{rendered || <span className="text-ink-muted">Write the message to see it here.</span>}</p>
        {rendered && (
          <p className="mt-2 text-xs text-ink-muted">
            {seg.characters.toLocaleString()} characters · {seg.segments} {seg.segments === 1 ? 'segment' : 'segments'} ({seg.encoding}). Each segment is billed by the carrier.
          </p>
        )}
      </div>
      <p className="text-xs text-ink-muted">
        Marketing texts must say how to opt out: “{SMS_OPT_OUT_INSTRUCTION}” is added when the text does not mention STOP. Only contacts with SMS
        consent receive it.
      </p>
    </div>
  );
}

/**
 * WhatsApp message (messaging amendment): an APPROVED Meta message template, by name and language, with values for its
 * body parameters {{1}}, {{2}}, … The template text is managed in WhatsApp Manager; Workeasy never shows a guess of it.
 */
export function WhatsAppMessageEditor({ value, disabled, onChange, errors }: { value: WhatsAppContentDraft; disabled: boolean; onChange: (v: WhatsAppContentDraft) => void; errors: Record<string, string[] | undefined> }) {
  const t = value.template;
  const set = (patch: Partial<WhatsAppContentDraft['template']>) => onChange({ schema: 'whatsapp.content.v1', template: { ...t, ...patch } });
  const sample = renderWhatsAppVariables({ schema: 'whatsapp.content.v1', template: { name: t.name || 'template', language: t.language || 'en', parameters: t.parameters } }, EXAMPLE_MERGE_DATA_V2);
  return (
    <div className="space-y-4">
      <Alert tone="info">
        WhatsApp marketing messages must use a template approved by Meta. Create it in WhatsApp Manager, then enter its exact name and language here.
      </Alert>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={MESSAGING_FIELD_ID['/messages/0/content/template/name']} label="Template name" errors={errors['messages.0.content.template.name']} hint="Lowercase letters, digits and underscores, e.g. spring_sale.">
          {(p) => <Input {...p} value={t.name} disabled={disabled} maxLength={WHATSAPP_CONTENT_LIMITS.name} onChange={(e) => set({ name: e.target.value })} />}
        </Field>
        <Field id={MESSAGING_FIELD_ID['/messages/0/content/template/language']} label="Template language" errors={errors['messages.0.content.template.language']} hint="As approved, e.g. en, en_US or pt_BR.">
          {(p) => <Input {...p} value={t.language} disabled={disabled} maxLength={12} onChange={(e) => set({ language: e.target.value })} />}
        </Field>
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-ink">Template parameters</legend>
        {t.parameters.length === 0 && <p className="text-sm text-ink-muted">This template has no parameters.</p>}
        {t.parameters.map((p, i) => (
          <div key={i} className="flex items-end gap-2">
            <div className="flex-1">
              <Field label={`Parameter {{${i + 1}}}`} errors={errors[`messages.0.content.template.parameters.${i}`]} hint={`Example: ${sample[String(i + 1)] ?? ''}`}>
                {(fp) => (
                  <Input
                    {...fp}
                    value={p}
                    disabled={disabled}
                    maxLength={WHATSAPP_CONTENT_LIMITS.parameter}
                    onChange={(e) => set({ parameters: t.parameters.map((x, j) => (j === i ? e.target.value : x)) })}
                  />
                )}
              </Field>
            </div>
            <Button variant="ghost" size="sm" disabled={disabled} aria-label={`Remove parameter ${i + 1}`} onClick={() => set({ parameters: t.parameters.filter((_, j) => j !== i) })} icon={<Trash2 className="size-4" aria-hidden />} />
          </div>
        ))}
        {t.parameters.length < WHATSAPP_CONTENT_LIMITS.parameters && (
          <Button variant="secondary" size="sm" disabled={disabled} onClick={() => set({ parameters: [...t.parameters, ''] })} icon={<Plus className="size-4" aria-hidden />}>
            Add parameter
          </Button>
        )}
      </fieldset>
      <p className="text-xs text-ink-muted">Only contacts with WhatsApp consent receive it. They can opt out using the template’s opt-out option.</p>
    </div>
  );
}
