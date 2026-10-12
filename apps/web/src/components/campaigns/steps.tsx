'use client';

import type { CampaignView, FindingSection } from '@workeasy/shared';
import { AlertCircle, CheckCircle2, TriangleAlert } from 'lucide-react';
import { cx } from '@/lib/format';

/** The creation workflow as steps, each backed by sections of the SERVER's readiness findings (never decided here). */
export const STEPS: { key: string; label: string; target: string; sections: FindingSection[] }[] = [
  { key: 'details', label: 'Details', target: 'step-details', sections: ['details', 'topic', 'channel'] },
  { key: 'audience', label: 'Audience', target: 'step-audience', sections: ['audience'] },
  { key: 'sender', label: 'Sender', target: 'step-sender', sections: ['sender'] },
  { key: 'message', label: 'Message', target: 'step-message', sections: ['message'] },
  { key: 'schedule', label: 'Schedule', target: 'step-schedule', sections: ['schedule'] },
  { key: 'review', label: 'Review and send', target: 'step-review', sections: ['delivery'] },
];

type Outcome = 'pass' | 'warning' | 'error';

function outcomeOf(campaign: CampaignView, sections: FindingSection[]): Outcome {
  const f = campaign.readinessFindings.filter((x) => sections.includes(x.section));
  return f.some((x) => x.severity === 'error') ? 'error' : f.some((x) => x.severity === 'warning') ? 'warning' : 'pass';
}

const LABEL: Record<Outcome, string> = { pass: 'done', warning: 'has warnings', error: 'needs attention' };

/**
 * Progress through the creation workflow (Phase 7.4). Statuses come from the campaign view's readiness findings — the
 * server's quick check; the audience size and eligibility are confirmed by the full check in the review. Each step
 * moves focus to its section.
 */
export function CampaignSteps({ campaign }: { campaign: CampaignView }) {
  return (
    <nav aria-label="Campaign steps">
      <ol className="flex flex-wrap gap-2">
        {STEPS.map((s, i) => {
          const o = s.key === 'review' ? (campaign.readiness === 'ready' ? outcomeOf(campaign, s.sections) : 'error') : outcomeOf(campaign, s.sections);
          const Icon = o === 'pass' ? CheckCircle2 : o === 'warning' ? TriangleAlert : AlertCircle;
          return (
            <li key={s.key}>
              <a
                href={`#${s.target}`}
                onClick={(e) => {
                  const el = document.getElementById(s.target);
                  if (el) {
                    e.preventDefault();
                    el.focus();
                    el.scrollIntoView({ block: 'start' });
                  }
                }}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-sm hover:border-accent"
              >
                <Icon className={cx('size-4', o === 'pass' ? 'text-success' : o === 'warning' ? 'text-warning' : 'text-danger')} aria-hidden />
                <span>
                  {i + 1}. {s.label}
                </span>
                <span className="sr-only">: {s.key === 'review' && o === 'error' ? 'not ready yet' : LABEL[o]}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
