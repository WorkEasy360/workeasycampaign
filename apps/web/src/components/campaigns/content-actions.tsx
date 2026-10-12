'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CampaignPreview, CampaignTestSend, CampaignView, ContactPage, TemplateView } from '@workeasy/shared';
import { useState } from 'react';
import { Alert, Button, Dialog, Field, Input, Spinner } from '@/components/ui';
import { ApiError, http } from '@/lib/api';
import { useWorkspaceApi } from '@/lib/audience';
import { campaignKeys } from '@/lib/campaigns';
import { mergeFieldLabel, templateKeys, useTemplateList } from '@/lib/content';
import { relativeTime } from '@/lib/format';
import { useCan, useOptionalAppContext } from '@/lib/session';
import { ErrorAlert } from './common';
import { PreviewFrame } from './message-editor';

/**
 * Template and preview actions of a campaign message (content amendment §5–§6). They act on the SAVED draft, so they
 * are offered only without unsaved edits; the server enforces permissions and state (the UI only hides what it must).
 */
export function ContentActions({ campaign, dirty, editable, onApplied }: { campaign: CampaignView; dirty: boolean; editable: boolean; onApplied: (next: CampaignView) => void }) {
  const can = useCan();
  const [open, setOpen] = useState<'apply' | 'save' | 'contact' | 'test' | null>(null);
  const schema = campaign.draft.messages[0]?.content.schema;
  const designed = schema === 'email.content.v2' || schema === 'email.content.v3';
  const actions = [
    editable && can('templates.read') && { key: 'apply' as const, label: 'Use a template' },
    designed && can('templates.manage') && { key: 'save' as const, label: 'Save as template' },
    can('contacts.read') && { key: 'contact' as const, label: 'Preview as a contact' },
    can('campaigns.update') && { key: 'test' as const, label: 'Send a test to me' },
  ].filter(Boolean) as { key: 'apply' | 'save' | 'contact' | 'test'; label: string }[];
  if (!actions.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {actions.map((a) => (
        <Button key={a.key} size="sm" variant="secondary" disabled={dirty} aria-describedby={dirty ? 'content-actions-dirty' : undefined} onClick={() => setOpen(a.key)}>
          {a.label}
        </Button>
      ))}
      {dirty && (
        <span id="content-actions-dirty" className="text-xs text-ink-muted">
          Save or discard your changes first.
        </span>
      )}
      <ApplyTemplateDialog open={open === 'apply'} campaign={campaign} onClose={() => setOpen(null)} onApplied={onApplied} />
      <SaveTemplateDialog open={open === 'save'} campaign={campaign} onClose={() => setOpen(null)} />
      <ContactPreviewDialog open={open === 'contact'} campaign={campaign} onClose={() => setOpen(null)} />
      <TestSendDialog open={open === 'test'} campaign={campaign} onClose={() => setOpen(null)} />
    </div>
  );
}

/**
 * Test send (Phase 7.3): the SAVED draft, rendered with the example contact, to the user's own address only. The
 * server decides everything (delivery availability, content errors, verification, rate limit).
 */
function TestSendDialog({ open, campaign, onClose }: { open: boolean; campaign: CampaignView; onClose: () => void }) {
  const { path } = useWorkspaceApi();
  const me = useOptionalAppContext()?.user;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState<CampaignTestSend | null>(null);
  const close = () => {
    setError(null);
    setSent(null);
    onClose();
  };
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      setSent(await http.post<CampaignTestSend>(path(`/campaigns/${campaign.id}/test-send`), {}));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Send a test to me"
      description="The saved message, filled in with an example contact, is sent to your own address — no contacts receive it."
      footer={
        sent ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button loading={busy} onClick={() => void send()}>
              Send test
            </Button>
          </>
        )
      }
    >
      {sent ? (
        <Alert tone="success" title="Test sent">
          “{sent.subject}” was sent to {sent.sentTo}.
        </Alert>
      ) : (
        <>
          {me?.email && <p className="text-sm">It goes to <strong>{me.email}</strong>.</p>}
          {error != null && <ErrorAlert error={error} title="The test was not sent" />}
        </>
      )}
    </Dialog>
  );
}

function ApplyTemplateDialog({ open, campaign, onClose, onApplied }: { open: boolean; campaign: CampaignView; onClose: () => void; onApplied: (next: CampaignView) => void }) {
  const { workspaceId, path } = useWorkspaceApi();
  const qc = useQueryClient();
  const list = useTemplateList('', open);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const apply = async (templateId: string) => {
    setBusy(templateId);
    setError(null);
    try {
      const next = await http.post<CampaignView>(path(`/campaigns/${campaign.id}/apply-template`), { templateId, expectedVersion: campaign.version });
      qc.setQueryData(campaignKeys.one(workspaceId!, campaign.id), next);
      onApplied(next);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Use a template" description="The template's subject and content replace this message. Your audience, sender and schedule stay as they are.">
      {error != null && (error instanceof ApiError && error.code === 'version_conflict' ? <Alert tone="warning" title="Changed by someone else">Reload the campaign and try again.</Alert> : <ErrorAlert error={error} title="The template could not be applied" />)}
      {list.isLoading ? (
        <Spinner label="Loading templates" />
      ) : list.isError ? (
        <ErrorAlert error={list.error} title="Templates could not be loaded" onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-muted">No templates yet. Save a designed email as a template to reuse it.</p>
      ) : (
        <ul className="divide-y divide-line" aria-label="Templates">
          {rows.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{t.name}</p>
                <p className="truncate text-xs text-ink-muted">
                  {t.subject} · {t.blockCount} blocks · updated {relativeTime(t.updatedAt)}
                </p>
              </div>
              <Button size="sm" loading={busy === t.id} disabled={busy !== null} onClick={() => void apply(t.id)} aria-label={`Use template ${t.name}`}>
                Use
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function SaveTemplateDialog({ open, campaign, onClose }: { open: boolean; campaign: CampaignView; onClose: () => void }) {
  const { workspaceId, path } = useWorkspaceApi();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState<TemplateView | null>(null);
  const close = () => {
    setName('');
    setError(null);
    setSaved(null);
    onClose();
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const t = await http.post<TemplateView>(path('/templates'), { name, fromCampaignId: campaign.id });
      await qc.invalidateQueries({ queryKey: templateKeys.all(workspaceId!) });
      setSaved(t);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Save as template"
      description="Saves this message's subject and content for reuse. Later changes to the template never change campaigns that used it."
      footer={
        saved ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button loading={busy} disabled={!name.trim()} onClick={() => void save()}>
              Save template
            </Button>
          </>
        )
      }
    >
      {saved ? (
        <Alert tone="success">Saved as “{saved.name}”.</Alert>
      ) : (
        <div className="space-y-3">
          {error != null && <ErrorAlert error={error} title="The template could not be saved" />}
          <Field label="Template name" errors={error instanceof ApiError ? error.fields.name : undefined}>
            {(p) => <Input {...p} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} data-autofocus />}
          </Field>
        </div>
      )}
    </Dialog>
  );
}

function ContactPreviewDialog({ open, campaign, onClose }: { open: boolean; campaign: CampaignView; onClose: () => void }) {
  const { workspaceId, path } = useWorkspaceApi();
  const [q, setQ] = useState('');
  const [contactId, setContactId] = useState<string | null>(null);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const search = useQuery({
    queryKey: ['campaign-preview-contacts', workspaceId, q],
    queryFn: ({ signal }) => http.get<ContactPage>(path(`/contacts?limit=10&q=${encodeURIComponent(q)}`), signal),
    enabled: open && !!workspaceId && q.trim().length >= 2,
  });
  const preview = useQuery({
    queryKey: ['campaign-preview', workspaceId, campaign.id, campaign.version, contactId],
    queryFn: () => http.post<CampaignPreview>(path(`/campaigns/${campaign.id}/preview`), { contactId }),
    enabled: open && !!contactId,
    retry: false,
  });
  const close = () => {
    setQ('');
    setContactId(null);
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} title="Preview as a contact" description="Shows the saved message with this contact's details. Nothing is sent and nothing is recorded.">
      {!contactId ? (
        <div className="space-y-3">
          <Field label="Find a contact" hint="Name or email, at least 2 characters.">
            {(p) => <Input {...p} type="search" value={q} onChange={(e) => setQ(e.target.value)} data-autofocus />}
          </Field>
          {search.isFetching && <Spinner label="Searching" />}
          {search.isError && <ErrorAlert error={search.error} title="Contacts could not be searched" />}
          {search.data && (search.data.data.length === 0 ? (
            <p className="text-sm text-ink-muted">No contact matches.</p>
          ) : (
            <ul className="divide-y divide-line" aria-label="Matching contacts">
              {search.data.data.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0 truncate text-sm">
                    {c.displayName}
                    {c.email ? <span className="text-ink-muted"> · {c.email}</span> : null}
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => setContactId(c.id)} aria-label={`Preview as ${c.displayName}`}>
                    Preview
                  </Button>
                </li>
              ))}
            </ul>
          ))}
        </div>
      ) : preview.isLoading ? (
        <Spinner label="Building the preview" />
      ) : preview.isError ? (
        <ErrorAlert error={preview.error} title="The preview could not be built" />
      ) : preview.data ? (
        <div className="space-y-3">
          {preview.data.missingTags.length > 0 && (
            <Alert tone="info" title="Some personal fields are empty for this contact">
              {preview.data.missingTags.map(mergeFieldLabel).join(', ')} — the fallback (or nothing) is shown instead.
            </Alert>
          )}
          <PreviewFrame {...preview.data} device={device} onDevice={setDevice} />
          <Button size="sm" variant="secondary" onClick={() => setContactId(null)}>
            Choose another contact
          </Button>
        </div>
      ) : null}
    </Dialog>
  );
}
