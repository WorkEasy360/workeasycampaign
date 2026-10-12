'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type AudienceSelector, type CampaignView, CAMPAIGN_DRAFT_LIMITS, type SenderIdentityView, updateCampaignRequest, type SmsContentDraft, type WhatsAppContentDraft } from '@workeasy/shared';
import Link from 'next/link';
import { Save, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Field, Input, Select, useToast } from '@/components/ui';
import { ApiError, http } from '@/lib/api';
import { useLists, useTags, useTopics, useWorkspaceApi } from '@/lib/audience';
import { campaignKeys, isoToZoned, timeZones, viewerTimeZone, zonedToIso } from '@/lib/campaigns';
import { useForm } from '@/lib/forms';
import { useCan } from '@/lib/session';
import { emptyDesignedEmail } from '@/lib/content';
import { ContentActions } from './content-actions';
import { type MessageContent, MessageEditor } from './message-editor';
import { MESSAGING_FIELD_ID, SmsMessageEditor, WhatsAppMessageEditor } from './messaging-editor';
import { AudienceSample } from './audience-sample';
import { CampaignSteps } from './steps';

/** Field ids so readiness findings (JSON pointers) can link straight to the control. */
export const FIELD_ID: Record<string, string> = {
  '/name': 'campaign-name',
  '/topicId': 'campaign-topic',
  '/audience': 'campaign-include',
  '/audience/include': 'campaign-include',
  '/audience/exclude': 'campaign-exclude',
  '/sender/senderIdentityId': 'campaign-sender-identity',
  '/sender/fromName': 'campaign-from-name',
  '/sender/replyTo': 'campaign-reply-to',
  '/messages/0/content/subject': 'campaign-subject',
  '/messages/0/content/preheader': 'campaign-preheader',
  '/messages/0/content/body/text': 'campaign-body',
  ...MESSAGING_FIELD_ID,
  '/schedule/sendAt': 'campaign-send-at',
  '/schedule/timezone': 'campaign-timezone',
};

interface Draft {
  name: string;
  description: string;
  topicId: string | null;
  include: AudienceSelector[];
  exclude: AudienceSelector[];
  senderIdentityId: string | null;
  fromName: string;
  replyTo: string;
  /** The default message: email (plain text v1, designed v2/v3), an SMS text, or a WhatsApp template. */
  content: MessageContent | SmsContentDraft | WhatsAppContentDraft;
  mode: 'now' | 'at';
  sendAtLocal: string;
  timezone: string;
}

function fromView(c: CampaignView): Draft {
  const m = c.draft.messages[0]?.content;
  const tz = c.draft.schedule.timezone || viewerTimeZone();
  return {
    name: c.name,
    description: c.description,
    topicId: c.draft.topicId,
    include: c.draft.audience.include,
    exclude: c.draft.audience.exclude,
    senderIdentityId: c.draft.sender.senderIdentityId,
    fromName: c.draft.sender.fromName ?? '',
    replyTo: c.draft.sender.replyTo ?? '',
    // A campaign without a message yet starts with its channel's empty message (email: a designed email).
    content: (m as Draft['content'] | undefined) ?? emptyMessageFor(c.channel),
    mode: c.draft.schedule.mode,
    sendAtLocal: c.draft.schedule.sendAt ? isoToZoned(c.draft.schedule.sendAt, tz) : '',
    timezone: tz,
  };
}

function emptyMessageFor(channel: CampaignView['channel']): Draft['content'] {
  if (channel === 'sms') return { schema: 'sms.content.v1', text: '' };
  if (channel === 'whatsapp') return { schema: 'whatsapp.content.v1', template: { name: '', language: 'en', parameters: [] } };
  return emptyDesignedEmail();
}

const key = (s: AudienceSelector) => (s.type === 'list' ? `list:${s.listId}` : `tag:${s.tagId}`);

/** The PATCH body: only changed fields, plus expectedVersion (contract §15 row 6). */
function changes(c: CampaignView, d: Draft): Record<string, unknown> {
  const base = fromView(c);
  const out: Record<string, unknown> = {};
  if (d.name !== base.name) out.name = d.name;
  if (d.description !== base.description) out.description = d.description;
  if (d.topicId !== base.topicId) out.topicId = d.topicId;
  if (JSON.stringify([d.include, d.exclude]) !== JSON.stringify([base.include, base.exclude])) out.audience = { include: d.include, exclude: d.exclude };
  if (d.senderIdentityId !== base.senderIdentityId || d.fromName !== base.fromName || d.replyTo !== base.replyTo) {
    out.sender = { senderIdentityId: d.senderIdentityId, fromName: d.fromName || null, replyTo: d.replyTo || null };
  }
  if (JSON.stringify(d.content) !== JSON.stringify(base.content)) out.messages = [{ variantKey: 'default', content: d.content }];
  if (d.mode !== base.mode || d.sendAtLocal !== base.sendAtLocal || d.timezone !== base.timezone) {
    out.schedule = { mode: d.mode, sendAt: d.mode === 'at' ? (zonedToIso(d.sendAtLocal, d.timezone) ?? null) : null, timezone: d.timezone };
  }
  return out;
}

/** Sender identity (Phase 7.8b): the address and its verification state, as the server reports it. */
function SenderPicker({ value, disabled, onChange }: { value: string | null; disabled: boolean; onChange: (v: string | null) => void }) {
  const { workspaceId, path } = useWorkspaceApi();
  const can = useCan();
  const q = useQuery({ queryKey: ['sender-identities', workspaceId] as const, queryFn: ({ signal }) => http.get<{ data: SenderIdentityView[] }>(path('/sender-identities'), signal), enabled: !!workspaceId });
  const rows = q.data?.data ?? [];
  const chosen = rows.find((r) => r.id === value);
  return (
    <Field
      id={FIELD_ID['/sender/senderIdentityId']}
      label="From address"
      hint={
        chosen && !chosen.verified ? (
          <span className="text-warning">This address is on a domain that is not verified yet.</span>
        ) : rows.length === 0 && !q.isLoading ? (
          <>
            No sender addresses yet.{' '}
            {can('deliverability.manage') && (
              // Inside a sentence: underlined, never colour alone (WCAG 1.4.1, axe link-in-text-block).
              <Link href="/settings/sending" className="text-accent underline underline-offset-2">
                Add a sending domain
              </Link>
            )}
          </>
        ) : undefined
      }
    >
      {(p) => (
        <Select {...p} value={value ?? ''} disabled={disabled || q.isLoading} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Choose a sender address…</option>
          {value && !chosen && !q.isLoading && <option value={value}>(an address that no longer exists)</option>}
          {rows.map((r) => (
            <option key={r.id} value={r.id}>
              {r.displayName} &lt;{r.email}&gt;{r.verified ? '' : ' — not verified'}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

export function DraftEditor({ campaign, onReload }: { campaign: CampaignView; onReload: () => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const { workspaceId, path } = useWorkspaceApi();
  const form = useForm(updateCampaignRequest);
  const editable = campaign.allowedActions.includes('update');
  // `base` = the server view the form was loaded from; local edits are the difference to it.
  const [base, setBase] = useState(campaign);
  const [draft, setDraft] = useState(() => fromView(campaign));
  const [conflict, setConflict] = useState(false);
  const baseVersion = base.version;
  const patch = useMemo(() => changes(base, draft), [base, draft]);
  const dirty = Object.keys(patch).length > 0;

  // A newer server version (restore, another person's save, a lifecycle command) replaces the form only when there
  // are no local edits — never discard work; with local edits the save reports the conflict instead.
  useEffect(() => {
    if (campaign.version !== base.version && !dirty) {
      setBase(campaign);
      setDraft(fromView(campaign));
    }
  }, [campaign, base.version, dirty]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const save = () =>
    void form.submit({ expectedVersion: baseVersion, ...patch }, async (data) => {
      try {
        const next = await http.patch<CampaignView>(path(`/campaigns/${campaign.id}`), data);
        qc.setQueryData(campaignKeys.one(workspaceId!, campaign.id), next);
        await qc.invalidateQueries({ queryKey: campaignKeys.counts(workspaceId!) });
        setBase(next);
        setDraft(fromView(next));
        setConflict(false);
        toast('success', 'Draft saved');
      } catch (err) {
        if (err instanceof ApiError && err.code === 'version_conflict') {
          setConflict(true);
          return;
        }
        throw err;
      }
    });

  return (
    <div className="space-y-6">
      {conflict && (
        <Alert tone="warning" title="Changed by someone else">
          This campaign was changed after you opened it. Your edits are still here; reload to see the latest version, then apply them again.
          <div className="mt-2">
            <Button size="sm" variant="secondary" onClick={() => { setConflict(false); setBase(campaign); setDraft(fromView(campaign)); onReload(); }}>
              Reload latest version
            </Button>
          </div>
        </Alert>
      )}
      {form.formError && !conflict && <Alert tone="danger">{form.formError}</Alert>}
      {!editable && <Alert tone="info">This draft is read-only for you{campaign.status !== 'draft' ? ' because the campaign is no longer a draft' : ''}.</Alert>}

      <CampaignSteps campaign={base} />

      <Card id="step-details" title="Details">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={FIELD_ID['/name']} label="Name" errors={form.fieldErrors.name}>
            {(p) => <Input {...p} value={draft.name} disabled={!editable} maxLength={CAMPAIGN_DRAFT_LIMITS.name} onChange={(e) => set('name', e.target.value)} />}
          </Field>
          <TopicField value={draft.topicId} disabled={!editable || !can('topics.read')} onChange={(v) => set('topicId', v)} />
          <div className="sm:col-span-2">
            <Field label="Description (optional)" errors={form.fieldErrors.description}>
              {(p) => <Input {...p} value={draft.description} disabled={!editable} maxLength={CAMPAIGN_DRAFT_LIMITS.description} onChange={(e) => set('description', e.target.value)} />}
            </Field>
          </div>
        </div>
      </Card>

      <Card
        id="step-audience"
        title="Audience"
        description="Choose the lists and tags to include, and any to leave out. The audience is fixed when the campaign starts; unsubscribes and suppressions are always respected."
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectorPicker id={FIELD_ID['/audience/include']!} label="Send to" value={draft.include} other={draft.exclude} disabled={!editable} onChange={(v) => set('include', v)} />
            <SelectorPicker id={FIELD_ID['/audience/exclude']!} label="Leave out" value={draft.exclude} other={draft.include} disabled={!editable} onChange={(v) => set('exclude', v)} />
          </div>
          <AudienceSample campaignId={base.id} dirty={dirty} />
        </div>
      </Card>

      {base.channel === 'email' ? (
      <Card id="step-sender" title="Sender" description="Who the email is from. Real recipients only receive email from addresses on a domain verified in DNS.">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <SenderPicker value={draft.senderIdentityId} disabled={!editable} onChange={(v) => set('senderIdentityId', v)} />
          </div>
          <Field id={FIELD_ID['/sender/fromName']} label="From name (optional)" errors={form.fieldErrors['sender.fromName']}>
            {(p) => <Input {...p} value={draft.fromName} disabled={!editable} maxLength={CAMPAIGN_DRAFT_LIMITS.fromName} onChange={(e) => set('fromName', e.target.value)} />}
          </Field>
          <Field id={FIELD_ID['/sender/replyTo']} label="Reply-to address (optional)" errors={form.fieldErrors['sender.replyTo']}>
            {(p) => <Input {...p} type="email" value={draft.replyTo} disabled={!editable} maxLength={CAMPAIGN_DRAFT_LIMITS.replyTo} onChange={(e) => set('replyTo', e.target.value)} />}
          </Field>
        </div>
      </Card>
      ) : (
        <Card id="step-sender" title="Sender">
          <p className="text-sm text-ink-muted">
            {base.channel === 'sms' ? 'Texts are sent from your organization’s SMS number.' : 'Messages are sent from your organization’s WhatsApp Business number.'} It is set up by
            your administrator with the provider.
          </p>
        </Card>
      )}

      <Card
        id="step-message"
        title="Message"
        description={
          base.channel === 'email'
            ? 'What recipients see. Personal fields such as the first name are filled in for each contact; an unsubscribe link is always added.'
            : base.channel === 'sms'
              ? 'The text recipients get. Personal fields are filled in for each contact; the opt-out instruction is always included.'
              : 'The approved WhatsApp template recipients get, with its parameters filled in for each contact.'
        }
        actions={
          base.channel !== 'email' ? undefined : (
          <ContentActions
            campaign={base}
            dirty={dirty}
            editable={editable}
            onApplied={(next) => {
              setBase(next);
              setDraft(fromView(next));
              toast('success', 'Template applied');
            }}
          />
          )
        }
      >
        {draft.content.schema === 'sms.content.v1' ? (
          <SmsMessageEditor value={draft.content} disabled={!editable} errors={form.fieldErrors} onChange={(content) => set('content', content)} />
        ) : draft.content.schema === 'whatsapp.content.v1' ? (
          <WhatsAppMessageEditor value={draft.content} disabled={!editable} errors={form.fieldErrors} onChange={(content) => set('content', content)} />
        ) : (
          <MessageEditor value={draft.content} disabled={!editable} errors={form.fieldErrors} onChange={(content) => set('content', content)} />
        )}
      </Card>

      <Card id="step-schedule" title="Schedule" description="Choose when to send. You confirm the time again when you schedule.">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="When">
            {(p) => (
              <Select {...p} value={draft.mode} disabled={!editable} onChange={(e) => set('mode', e.target.value as Draft['mode'])}>
                <option value="now">As soon as it is scheduled</option>
                <option value="at">At a date and time</option>
              </Select>
            )}
          </Field>
          {draft.mode === 'at' && (
            <Field id={FIELD_ID['/schedule/sendAt']} label="Date and time">
              {(p) => <Input {...p} type="datetime-local" value={draft.sendAtLocal} disabled={!editable} onChange={(e) => set('sendAtLocal', e.target.value)} />}
            </Field>
          )}
          <Field id={FIELD_ID['/schedule/timezone']} label="Time zone">
            {(p) => (
              <Select {...p} value={draft.timezone} disabled={!editable} onChange={(e) => set('timezone', e.target.value)}>
                {timeZones().map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Card>

      {editable && (
        <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-end gap-3 border-t border-line bg-canvas/95 px-1 py-3 backdrop-blur">
          <span className="text-sm text-ink-muted" aria-live="polite">
            {dirty ? 'Unsaved changes' : 'All changes saved'}
          </span>
          <Button variant="secondary" disabled={!dirty || form.submitting} onClick={() => setDraft(fromView(base))}>
            Discard
          </Button>
          <Button icon={<Save className="size-4" aria-hidden />} disabled={!dirty} loading={form.submitting} onClick={save}>
            Save draft
          </Button>
        </div>
      )}
    </div>
  );
}

function TopicField({ value, disabled, onChange }: { value: string | null; disabled: boolean; onChange: (v: string | null) => void }) {
  const topics = useTopics();
  const options = (topics.data?.data ?? []).filter((t) => t.kind === 'topic' && (t.status === 'active' || t.id === value));
  return (
    <Field id={FIELD_ID['/topicId']} label="Topic" hint="What this campaign is about. Contacts who unsubscribed from the topic are never sent to.">
      {(p) => (
        <Select {...p} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Choose a topic</option>
          {options.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.status !== 'active' ? ' (archived)' : ''}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

/** Lists and tags as removable chips plus an "add" select; needs lists.read / tags.read (the API enforces them on save). */
function SelectorPicker({ id, label, value, other, disabled, onChange }: { id: string; label: string; value: AudienceSelector[]; other: AudienceSelector[]; disabled: boolean; onChange: (v: AudienceSelector[]) => void }) {
  const can = useCan();
  const lists = useLists();
  const tags = useTags();
  const names = new Map<string, string>([
    ...(lists.data?.data ?? []).map((l) => [`list:${l.id}`, `List · ${l.name}${l.status === 'archived' ? ' (archived)' : ''}`] as const),
    ...(tags.data?.data ?? []).map((t) => [`tag:${t.id}`, `Tag · ${t.name}`] as const),
  ]);
  const taken = new Set([...value, ...other].map(key));
  const choices = [
    ...(can('lists.read') ? (lists.data?.data ?? []).filter((l) => l.status === 'active').map((l) => ({ k: `list:${l.id}`, label: `List · ${l.name}` })) : []),
    ...(can('tags.read') ? (tags.data?.data ?? []).map((t) => ({ k: `tag:${t.id}`, label: `Tag · ${t.name}` })) : []),
  ].filter((c) => !taken.has(c.k));
  const add = (k: string) => {
    const [type, idPart] = k.split(':') as ['list' | 'tag', string];
    onChange([...value, type === 'list' ? { type, listId: idPart } : { type, tagId: idPart }]);
  };
  return (
    <div className="space-y-2">
      <Field id={id} label={label}>
        {(p) => (
          <Select {...p} value="" disabled={disabled || choices.length === 0} onChange={(e) => e.target.value && add(e.target.value)}>
            <option value="">{choices.length ? 'Add a list or tag…' : 'No more lists or tags'}</option>
            {choices.map((c) => (
              <option key={c.k} value={c.k}>
                {c.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {value.length === 0 ? (
        <p className="text-xs text-ink-muted">None selected.</p>
      ) : (
        <ul className="flex flex-wrap gap-2" aria-label={`${label}: selected`}>
          {value.map((s) => (
            <li key={key(s)} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-muted px-3 py-1 text-xs">
              {names.get(key(s)) ?? (s.type === 'list' ? 'List (not visible to you)' : 'Tag (not visible to you)')}
              {!disabled && (
                <button type="button" className="rounded-full p-0.5 hover:bg-line" aria-label={`Remove ${names.get(key(s)) ?? s.type}`} onClick={() => onChange(value.filter((x) => key(x) !== key(s)))}>
                  <X className="size-3" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
