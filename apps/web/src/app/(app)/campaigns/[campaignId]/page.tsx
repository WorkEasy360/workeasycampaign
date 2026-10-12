'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { CampaignsPage, ErrorAlert, StatusBadge } from '@/components/campaigns/common';
import { CampaignOutcomes } from '@/components/campaigns/campaign-outcomes';
import { DraftEditor } from '@/components/campaigns/draft-editor';
import { ExecutionPanel } from '@/components/campaigns/execution-panel';
import { HistoryPanel } from '@/components/campaigns/history-panel';
import { LifecycleActions } from '@/components/campaigns/lifecycle';
import { ReadinessPanel } from '@/components/campaigns/readiness-panel';
import { Alert, Spinner } from '@/components/ui';
import { CHANNEL_LABEL } from '@/lib/audience';
import { useCampaign } from '@/lib/campaigns';
import { relativeTime } from '@/lib/format';

function CampaignInner() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const q = useCampaign(campaignId);
  const back = (
    <Link href="/campaigns" className="mb-4 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink">
      <ArrowLeft className="size-4" aria-hidden /> Campaigns
    </Link>
  );
  if (q.isLoading) return <Spinner label="Loading campaign" />;
  if (q.isError || !q.data) {
    return (
      <>
        {back}
        <ErrorAlert error={q.error} title="This campaign is not available" />
      </>
    );
  }
  const c = q.data;
  const isDraft = c.status === 'draft';
  return (
    <>
      {back}
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-semibold text-ink">{c.name}</h1>
            <StatusBadge status={c.status} />
          </div>
          <p className="mt-1 text-sm text-ink-muted">
            {CHANNEL_LABEL[c.channel]} campaign · updated {relativeTime(c.updatedAt)}
            {c.currentVersion && <> · version #{c.currentVersion.number}</>}
          </p>
        </div>
        <LifecycleActions campaign={c} />
      </header>
      {c.deletedAt && (
        <div className="mb-6">
          <Alert tone="warning" title="This campaign is deleted">
            It is read-only. Restore it to work on it again.
          </Alert>
        </div>
      )}
      {isDraft && !c.deletedAt ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <DraftEditor key={c.id} campaign={c} onReload={() => void q.refetch()} />
          <aside className="space-y-6 lg:sticky lg:top-4 lg:self-start" aria-label="Review">
            <ReadinessPanel campaign={c} />
          </aside>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-6">
            <ExecutionPanel campaign={c} />
            <CampaignOutcomes campaign={c} />
            <HistoryPanel campaign={c} />
          </div>
          <aside className="space-y-6" aria-label="Summary">
            <ReadinessPanel campaign={c} />
          </aside>
        </div>
      )}
      {isDraft && !c.deletedAt && (
        <div className="mt-6">
          <HistoryPanel campaign={c} />
        </div>
      )}
    </>
  );
}

export default function Page() {
  return (
    <CampaignsPage>
      <CampaignInner />
    </CampaignsPage>
  );
}
