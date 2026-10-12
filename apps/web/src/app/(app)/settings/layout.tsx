'use client';

import type { Permission } from '@workeasy/shared';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui';
import { cx } from '@/lib/format';
import { useCan } from '@/lib/session';

const TABS: { href: string; label: string; permission?: Permission }[] = [
  { href: '/settings', label: 'General' },
  { href: '/settings/members', label: 'Members', permission: 'members.read' },
  { href: '/settings/roles', label: 'Roles', permission: 'roles.read' },
  { href: '/settings/security', label: 'Security' },
  { href: '/settings/audit', label: 'Audit log', permission: 'audit.read' },
  { href: '/settings/sending', label: 'Sending domains', permission: 'campaigns.read' },
  { href: '/settings/usage', label: 'Usage', permission: 'billing.manage' },
];

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const can = useCan();
  return (
    <>
      <PageHeader title="Settings" description="Your profile, your team, and how this organization is secured." />
      <nav aria-label="Settings" className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.filter((t) => !t.permission || can(t.permission)).map((t) => {
          const active = pathname === t.href;
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? 'page' : undefined}
              className={cx(
                '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
                active ? 'border-accent text-accent' : 'border-transparent text-ink-muted hover:text-ink',
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </>
  );
}
