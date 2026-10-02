'use client';

import { BarChart3, CheckCircle2, Circle, GitBranch, Mail, ShieldCheck, Users } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui';
import { useAppContext, useCan } from '@/lib/session';

export default function DashboardPage() {
  const ctx = useAppContext();
  const can = useCan();
  const firstName = ctx.user.displayName.split(' ')[0];

  const steps: { done: boolean; label: string; detail: string; href?: string; show: boolean }[] = [
    { done: true, label: 'Create your organization', detail: `${ctx.organization!.name} is ready.`, show: true },
    { done: !!ctx.workspace, label: 'Open a workspace', detail: ctx.workspace ? `You are in ${ctx.workspace.name}.` : 'Choose or create a workspace.', href: '/workspaces', show: true },
    { done: false, label: 'Invite your team', detail: 'Add colleagues and choose what each person can do.', href: '/settings/members', show: can('members.invite') },
    { done: false, label: 'Review security', detail: 'Check active sessions and your password.', href: '/settings/security', show: true },
  ];

  return (
    <>
      <PageHeader
        title={`Welcome, ${firstName}`}
        description={ctx.workspace ? <>You are working in <strong className="text-ink">{ctx.workspace.name}</strong>.</> : 'Select a workspace to get started.'}
        actions={ctx.workspace?.status === 'archived' ? <Badge tone="warning">Archived — read only</Badge> : null}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Get set up" description="A few steps to make this workspace ready." className="lg:col-span-2">
          <ol className="space-y-3">
            {steps
              .filter((s) => s.show)
              .map((s) => (
                <li key={s.label} className="flex items-start gap-3">
                  {s.done ? <CheckCircle2 className="mt-0.5 size-5 text-success" aria-label="Done" /> : <Circle className="mt-0.5 size-5 text-ink-faint" aria-label="To do" />}
                  <div className="flex-1">
                    <p className={s.done ? 'text-sm text-ink-muted line-through' : 'text-sm font-medium'}>{s.label}</p>
                    <p className="text-xs text-ink-muted">{s.detail}</p>
                  </div>
                  {!s.done && s.href && (
                    <Link href={s.href} className="text-sm font-medium text-accent hover:underline">
                      Start
                    </Link>
                  )}
                </li>
              ))}
          </ol>
        </Card>
        <Card title="Your access">
          <div className="flex items-start gap-3 text-sm">
            <ShieldCheck className="mt-0.5 size-5 text-accent" aria-hidden />
            <p className="text-ink-muted">
              You have <strong className="text-ink">{ctx.permissions.length}</strong> permissions here. Ask an organization admin if you need more.
            </p>
          </div>
        </Card>
      </div>

      <h2 className="mb-3 mt-10 text-sm font-semibold uppercase tracking-wide text-ink-faint">Coming next</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Upcoming icon={<Users className="size-6" />} title="Contacts">Import and organise your audience with lists, segments and consent.</Upcoming>
        <Upcoming icon={<Mail className="size-6" />} title="Campaigns">Email, SMS and WhatsApp campaigns with pre-send checks.</Upcoming>
        <Upcoming icon={<GitBranch className="size-6" />} title="Journeys">Automated multi-step customer journeys.</Upcoming>
        <Upcoming icon={<BarChart3 className="size-6" />} title="Reports">Engagement and deliverability insights with next steps.</Upcoming>
      </div>
    </>
  );
}

function Upcoming({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <EmptyState icon={icon} title={title}>
      {children}
    </EmptyState>
  );
}
