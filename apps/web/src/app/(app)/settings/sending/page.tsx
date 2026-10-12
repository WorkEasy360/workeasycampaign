'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SenderIdentityView, SendingDomainView } from '@workeasy/shared';
import { Globe, Lock, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { RequireWorkspace } from '@/components/audience-shell';
import { ErrorAlert } from '@/components/campaigns/common';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, Field, Input, Spinner, Table, Td, Th, useToast } from '@/components/ui';
import { ApiError, http } from '@/lib/api';
import { useWorkspaceApi } from '@/lib/audience';
import { relativeTime } from '@/lib/format';
import { errorMessage } from '@/lib/forms';
import { useCan } from '@/lib/session';

const CHECK_LABEL = { ownership: 'Ownership', spf: 'SPF', dkim: 'DKIM', dmarc: 'DMARC' } as const;
const RESULT: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  pass: { label: 'Pass', tone: 'success' },
  fail: { label: 'Wrong value', tone: 'danger' },
  missing: { label: 'Missing', tone: 'danger' },
  error: { label: 'DNS lookup failed', tone: 'warning' },
  not_checked: { label: 'Not configured', tone: 'neutral' },
};
const STATUS: Record<SendingDomainView['status'], { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  verified: { label: 'Verified', tone: 'success' },
  pending: { label: 'Not verified yet', tone: 'warning' },
  failed: { label: 'Verification failed', tone: 'danger' },
};

/**
 * Sending domains and sender identities (Phase 7.8b). A domain is verified only by the server's DNS checks — this page
 * never claims it; it shows the records to publish and the last check. Real recipients only get email from verified
 * domains.
 */
function SendingInner() {
  const can = useCan();
  const manage = can('deliverability.manage');
  const { workspaceId, path } = useWorkspaceApi();
  const qc = useQueryClient();
  const toast = useToast();
  const domains = useQuery({ queryKey: ['sending-domains', workspaceId] as const, queryFn: ({ signal }) => http.get<{ data: SendingDomainView[] }>(path('/sending-domains'), signal), enabled: !!workspaceId });
  const identities = useQuery({ queryKey: ['sender-identities', workspaceId] as const, queryFn: ({ signal }) => http.get<{ data: SenderIdentityView[] }>(path('/sender-identities'), signal), enabled: !!workspaceId });
  const [domain, setDomain] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<unknown>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ kind: 'domain' | 'identity'; id: string; name: string } | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['sending-domains', workspaceId] }), qc.invalidateQueries({ queryKey: ['sender-identities', workspaceId] })]);

  const add = async () => {
    setAdding(true);
    setAddError(null);
    try {
      await http.post(path('/sending-domains'), { domain });
      setDomain('');
      await refresh();
      toast('success', 'Domain added. Publish its DNS records, then check it.');
    } catch (err) {
      setAddError(err);
    } finally {
      setAdding(false);
    }
  };
  const check = async (id: string) => {
    setChecking(id);
    try {
      const d = await http.post<SendingDomainView>(path(`/sending-domains/${id}/verify`));
      await refresh();
      toast(d.status === 'verified' ? 'success' : 'danger', d.status === 'verified' ? `${d.domain} is verified` : `${d.domain} is not verified yet — see the checks`);
    } catch (err) {
      toast('danger', errorMessage(err));
    } finally {
      setChecking(null);
    }
  };

  if (domains.isLoading) return <Spinner label="Loading sending domains" />;
  if (domains.isError) return <ErrorAlert error={domains.error} title="Sending domains could not be loaded" onRetry={() => void domains.refetch()} />;
  const rows = domains.data!.data;
  const byDomain = (id: string) => (identities.data?.data ?? []).filter((i) => i.domainId === id);

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-ink-muted">
        Campaigns are sent from addresses on your own domains. A domain is verified when its DNS has the ownership, SPF, DKIM and DMARC records below — we check
        them; nothing is assumed.
      </p>
      {manage && (
        <Card title="Add a sending domain">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full max-w-sm">
              <Field label="Domain" hint="A domain you control, e.g. mail.example.com" errors={addError instanceof ApiError ? addError.fields.domain : undefined}>
                {(p) => <Input {...p} value={domain} maxLength={253} onChange={(e) => setDomain(e.target.value)} />}
              </Field>
            </div>
            <Button icon={<Plus className="size-4" aria-hidden />} loading={adding} disabled={!domain.trim()} onClick={() => void add()}>
              Add domain
            </Button>
          </div>
          {addError != null && !(addError instanceof ApiError && addError.fields.domain) && <ErrorAlert error={addError} title="The domain was not added" />}
        </Card>
      )}
      {rows.length === 0 ? (
        <EmptyState icon={<Globe className="size-8" />} title="No sending domains yet">
          {manage ? 'Add the domain your campaigns should come from.' : 'Ask a workspace admin to add a sending domain.'}
        </EmptyState>
      ) : (
        rows.map((d) => (
          <Card
            key={d.id}
            title={d.domain}
            description={d.checkedAt ? `Last checked ${relativeTime(d.checkedAt)}` : 'Not checked yet'}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge>
                {manage && (
                  <>
                    <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" aria-hidden />} loading={checking === d.id} onClick={() => void check(d.id)}>
                      Check DNS now
                    </Button>
                    <Button size="sm" variant="secondary" icon={<Trash2 className="size-4" aria-hidden />} aria-label={`Remove ${d.domain}`} onClick={() => setRemoving({ kind: 'domain', id: d.id, name: d.domain })}>
                      Remove
                    </Button>
                  </>
                )}
              </div>
            }
          >
            <div className="space-y-4">
              <Table label={`DNS records for ${d.domain}`}>
                <thead>
                  <tr>
                    <Th>Record</Th>
                    <Th>Type</Th>
                    <Th>Host</Th>
                    <Th>Value</Th>
                    <Th>Last check</Th>
                  </tr>
                </thead>
                <tbody>
                  {d.records.map((r) => {
                    const result = d.checks ? RESULT[d.checks[r.purpose]] : null;
                    return (
                      <tr key={r.purpose}>
                        <Td>{CHECK_LABEL[r.purpose]}</Td>
                        <Td>{r.type}</Td>
                        <Td>
                          <code className="break-all text-xs">{r.host}</code>
                        </Td>
                        <Td>
                          <code className="break-all text-xs">{r.value}</code>
                        </Td>
                        <Td>{result ? <Badge tone={result.tone}>{result.label}</Badge> : <span className="text-ink-faint">—</span>}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              <IdentitiesOf domain={d} identities={byDomain(d.id)} manage={manage} onChanged={refresh} onRemove={(i) => setRemoving({ kind: 'identity', id: i.id, name: i.email })} />
            </div>
          </Card>
        ))
      )}
      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing?.name ?? ''}?`}
        body={removing?.kind === 'domain' ? 'Campaigns can no longer use addresses on it.' : 'Campaigns that use this address will need another sender before they can send.'}
        confirmLabel="Remove"
        error={removeError}
        onClose={() => {
          setRemoving(null);
          setRemoveError(null);
        }}
        onConfirm={() => {
          setRemoveError(null);
          http
            .delete(path(removing!.kind === 'domain' ? `/sending-domains/${removing!.id}` : `/sender-identities/${removing!.id}`))
            .then(async () => {
              await refresh();
              setRemoving(null);
            })
            .catch((err: unknown) => setRemoveError(errorMessage(err)));
        }}
      />
    </div>
  );
}

function IdentitiesOf({ domain, identities, manage, onChanged, onRemove }: { domain: SendingDomainView; identities: SenderIdentityView[]; manage: boolean; onChanged: () => Promise<unknown>; onRemove: (i: SenderIdentityView) => void }) {
  const { path } = useWorkspaceApi();
  const [localPart, setLocalPart] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fields = error instanceof ApiError ? error.fields : {};
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await http.post(path('/sender-identities'), { domainId: domain.id, localPart, displayName });
      setLocalPart('');
      setDisplayName('');
      await onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">Sender addresses</h3>
      {identities.length === 0 ? (
        <p className="text-sm text-ink-muted">No addresses on this domain yet.</p>
      ) : (
        <ul className="divide-y divide-line" aria-label={`Sender addresses on ${domain.domain}`}>
          {identities.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span>
                {i.displayName} &lt;{i.email}&gt;
              </span>
              {manage && (
                <Button size="sm" variant="secondary" aria-label={`Remove ${i.email}`} onClick={() => onRemove(i)}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {manage && (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Address" hint={`…@${domain.domain}`} errors={fields.localPart}>
            {(p) => <Input {...p} value={localPart} maxLength={64} onChange={(e) => setLocalPart(e.target.value)} />}
          </Field>
          <Field label="Name shown to recipients" errors={fields.displayName}>
            {(p) => <Input {...p} value={displayName} maxLength={100} onChange={(e) => setDisplayName(e.target.value)} />}
          </Field>
          <Button size="sm" loading={busy} disabled={!localPart.trim() || !displayName.trim()} onClick={() => void add()}>
            Add address
          </Button>
        </div>
      )}
      {error != null && !fields.localPart && !fields.displayName && <Alert tone="danger">{errorMessage(error)}</Alert>}
    </div>
  );
}

export default function Page() {
  const can = useCan();
  return (
    <RequireWorkspace>
      {can('campaigns.read') || can('deliverability.manage') ? (
        <SendingInner />
      ) : (
        <EmptyState icon={<Lock className="size-8" />} title="You can’t view sending domains">
          Your role in this workspace does not include campaigns. Ask a workspace admin if you need it.
        </EmptyState>
      )}
    </RequireWorkspace>
  );
}
