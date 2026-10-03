'use client';

import type { Permission } from '@workeasy/shared';
import { LayoutGrid } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cx } from '@/lib/format';
import { useAppContext, useCan } from '@/lib/session';
import { Button, EmptyState } from './ui';

/** Audience data lives in a workspace; without one selected there is nothing to show. */
export function RequireWorkspace({ children }: { children: ReactNode }) {
  const ctx = useAppContext();
  if (!ctx.workspaceId) {
    return (
      <EmptyState
        icon={<LayoutGrid className="size-8" />}
        title="Choose a workspace first"
        action={
          <Link href="/workspaces">
            <Button>Open a workspace</Button>
          </Link>
        }
      >
        Contacts, lists and imports belong to a workspace.
      </EmptyState>
    );
  }
  return <>{children}</>;
}

const TABS: { href: string; label: string; permission: Permission }[] = [
  { href: '/contacts', label: 'Contacts', permission: 'contacts.read' },
  { href: '/audience/lists', label: 'Lists', permission: 'lists.read' },
  { href: '/audience/tags', label: 'Tags', permission: 'tags.read' },
  { href: '/audience/topics', label: 'Topics', permission: 'topics.read' },
  { href: '/audience/fields', label: 'Custom fields', permission: 'contacts.read' },
  { href: '/audience/suppressions', label: 'Do not contact', permission: 'suppression.read' },
  { href: '/audience/consent', label: 'Consent', permission: 'consent.read' },
  { href: '/imports', label: 'Imports', permission: 'contacts.import' },
];

export function AudienceTabs() {
  const pathname = usePathname();
  const can = useCan();
  return (
    <nav aria-label="Audience" className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
      {TABS.filter((t) => can(t.permission)).map((t) => {
        const active = pathname === t.href || (t.href !== '/contacts' && pathname.startsWith(`${t.href}/`)) || (t.href === '/contacts' && pathname.startsWith('/contacts/'));
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={cx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', active ? 'border-accent text-accent' : 'border-transparent text-ink-muted hover:text-ink')}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Standard frame for audience pages: tabs + workspace guard. */
export function AudiencePage({ children }: { children: ReactNode }) {
  return (
    <>
      <AudienceTabs />
      <RequireWorkspace>{children}</RequireWorkspace>
    </>
  );
}
