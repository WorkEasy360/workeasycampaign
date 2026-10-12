'use client';

import { useQueryClient } from '@tanstack/react-query';
import { renderEmail } from '@workeasy/content';
import { type CampaignView, EXAMPLE_MERGE_DATA, EXAMPLE_MERGE_DATA_V2, type VersionSummary } from '@workeasy/shared';
import { useState } from 'react';
import { Alert, Button, Card, ConfirmDialog, Dialog, Spinner, Table, Td, Th, useToast } from '@/components/ui';
import { ApiError, http } from '@/lib/api';
import { useWorkspaceApi } from '@/lib/audience';
import { campaignKeys, useVersion, useVersions } from '@/lib/campaigns';
import { dateTime, relativeTime } from '@/lib/format';
import { errorMessage } from '@/lib/forms';

const REASON = { scheduled: 'Scheduled', sent_now: 'Sent now' } as const;

/** Versions (immutable snapshots made when scheduling): view, and restore into the draft when the server allows. */
export function HistoryPanel({ campaign }: { campaign: CampaignView }) {
  const versions = useVersions(campaign.id);
  const [viewing, setViewing] = useState<VersionSummary | null>(null);
  const [restoring, setRestoring] = useState<VersionSummary | null>(null);
  const rows = versions.data?.data ?? [];
  return (
    <Card title="History" description="A version is saved every time the campaign is scheduled. It never changes.">
      {versions.isLoading ? (
        <Spinner label="Loading history" />
      ) : versions.isError ? (
        <Alert tone="danger">{errorMessage(versions.error)}</Alert>
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-muted">No versions yet — one is created when you schedule.</p>
      ) : (
        <Table label="Versions">
          <thead>
            <tr>
              <Th>Version</Th>
              <Th>Reason</Th>
              <Th>By</Th>
              <Th>When</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.id}>
                <Td>#{v.number}</Td>
                <Td>{REASON[v.reason as keyof typeof REASON] ?? v.reason}</Td>
                <Td>{v.createdBy?.displayName ?? '—'}</Td>
                <Td title={dateTime(v.createdAt)}>{relativeTime(v.createdAt)}</Td>
                <Td className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" onClick={() => setViewing(v)}>
                    View
                  </Button>
                  {campaign.allowedActions.includes('update') && (
                    <Button size="sm" variant="ghost" onClick={() => setRestoring(v)}>
                      Restore into draft
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {viewing && <VersionDialog campaignId={campaign.id} version={viewing} onClose={() => setViewing(null)} />}
      {restoring && <RestoreDialog campaign={campaign} version={restoring} onClose={() => setRestoring(null)} />}
    </Card>
  );
}

function VersionDialog({ campaignId, version, onClose }: { campaignId: string; version: VersionSummary; onClose: () => void }) {
  const v = useVersion(campaignId, version.id);
  const content = v.data?.snapshot.messages[0]?.content;
  return (
    <Dialog open onClose={onClose} title={`Version #${version.number}`} description={`${REASON[version.reason as keyof typeof REASON] ?? version.reason} ${relativeTime(version.createdAt)}`}>
      {v.isLoading ? (
        <Spinner />
      ) : v.isError || !v.data ? (
        <Alert tone="danger">{errorMessage(v.error)}</Alert>
      ) : (
        <dl className="space-y-3 text-sm">
          {content?.schema === 'sms.content.v1' || content?.schema === 'whatsapp.content.v1' ? (
            <div>
              <dt className="text-ink-muted">{content.schema === 'sms.content.v1' ? 'Text message' : 'WhatsApp template'}</dt>
              <dd className="whitespace-pre-wrap rounded-control bg-surface-muted p-3">
                {content.schema === 'sms.content.v1'
                  ? content.text
                  : `${content.template.name} (${content.template.language})${content.template.parameters.length ? ` · parameters: ${content.template.parameters.join(', ')}` : ''}`}
              </dd>
            </div>
          ) : (
          <>
          <div>
            <dt className="text-ink-muted">Subject</dt>
            <dd>{content?.subject}</dd>
          </div>
          {content?.preheader && (
            <div>
              <dt className="text-ink-muted">Preview text</dt>
              <dd>{content.preheader}</dd>
            </div>
          )}
          <div>
            <dt className="text-ink-muted">Message</dt>
            {content?.schema === 'email.content.v2' || content?.schema === 'email.content.v3' ? (
              <dd>
                {/* Designed email: rendered by the shared renderer with the example contact, sandboxed (no scripts). */}
                <iframe title={`Version ${v.data.number} content`} sandbox="" srcDoc={renderEmail(content, content.schema === 'email.content.v3' ? EXAMPLE_MERGE_DATA_V2 : EXAMPLE_MERGE_DATA, { unsubscribeUrl: '#unsubscribe-preview', reason: 'you subscribed to emails from this sender' }).html} className="h-80 w-full rounded-control border border-line bg-white" />
              </dd>
            ) : (
              <dd className="max-h-64 overflow-auto whitespace-pre-wrap rounded-control bg-surface-muted p-3">{content?.body.text}</dd>
            )}
          </div>
          </>
          )}
          <div>
            <dt className="text-ink-muted">Audience</dt>
            <dd>
              {v.data.snapshot.audience.include.length} included, {v.data.snapshot.audience.exclude.length} excluded lists or tags
            </dd>
          </div>
        </dl>
      )}
    </Dialog>
  );
}

function RestoreDialog({ campaign, version, onClose }: { campaign: CampaignView; version: VersionSummary; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { workspaceId, path } = useWorkspaceApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={`Restore version #${version.number} into the draft?`}
      body="The draft's topic, audience, sender, message and schedule are replaced by this version. Unsaved edits on this page are discarded."
      confirmLabel="Restore"
      busy={busy}
      error={error}
      onConfirm={async () => {
        setBusy(true);
        setError(null);
        try {
          const next = await http.post<CampaignView>(path(`/campaigns/${campaign.id}/versions/${version.id}/restore`), { expectedVersion: campaign.version });
          qc.setQueryData(campaignKeys.one(workspaceId!, campaign.id), next);
          toast('success', `Version #${version.number} restored into the draft`);
          onClose();
        } catch (err) {
          setError(err instanceof ApiError && err.code === 'version_conflict' ? 'The campaign changed in the meantime. Reload and try again.' : errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
