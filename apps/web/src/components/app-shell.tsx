'use client';

import { useQuery } from '@tanstack/react-query';
import type { OrganizationView, WorkspaceView } from '@workeasy/shared';
import {
  BarChart3,
  Check,
  ChevronsUpDown,
  GitBranch,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  Settings,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { http } from '@/lib/api';
import { cx } from '@/lib/format';
import { keys, useResetCache } from '@/lib/session';
import { Logo } from './brand';
import { Avatar, Badge, useToast } from './ui';
import { useContextSafe } from './use-context-safe';

const NAV: { href: string; label: string; icon: typeof Users; soon?: boolean; match?: string[] }[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/contacts', label: 'Audience', icon: Users, match: ['/contacts', '/audience', '/imports'] },
  { href: '#campaigns', label: 'Campaigns', icon: Mail, soon: true },
  { href: '#journeys', label: 'Journeys', icon: GitBranch, soon: true },
  { href: '#reports', label: 'Reports', icon: BarChart3, soon: true },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => setMobileOpen(false), [pathname]);

  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col gap-1 p-3">
      <div className="mb-4 px-2 pt-1">
        <Logo />
      </div>
      <ContextSwitcher />
      <ul className="mt-4 space-y-0.5">
        {NAV.map(({ href, label, icon: Icon, soon, match }) => {
          const active = !soon && (match ?? [href]).some((m) => pathname === m || pathname.startsWith(`${m}/`));
          return (
            <li key={label}>
              {soon ? (
                <span className="flex cursor-not-allowed items-center gap-3 rounded-control px-3 py-2 text-sm text-ink-faint" aria-disabled>
                  <Icon className="size-4" aria-hidden />
                  {label}
                  <Badge>Soon</Badge>
                </span>
              ) : (
                <Link
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'flex items-center gap-3 rounded-control px-3 py-2 text-sm font-medium',
                    active ? 'bg-accent-soft text-accent' : 'text-ink-muted hover:bg-surface-muted hover:text-ink',
                  )}
                >
                  <Icon className="size-4" aria-hidden />
                  {label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-auto">
        <UserMenu />
      </div>
    </nav>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[260px_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-control focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-dvh border-r border-line bg-surface lg:block">{sidebar}</aside>
      <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-3 lg:hidden">
        <Logo />
        <button type="button" onClick={() => setMobileOpen(true)} aria-label="Open menu" className="rounded-control p-2 hover:bg-surface-muted">
          <Menu className="size-5" />
        </button>
      </header>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 bg-surface shadow-xl">
            <button type="button" onClick={() => setMobileOpen(false)} aria-label="Close menu" className="absolute right-3 top-3 rounded-control p-2 hover:bg-surface-muted">
              <X className="size-5" />
            </button>
            {sidebar}
          </div>
        </div>
      )}
      <main id="main" className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8">
        {children}
      </main>
    </div>
  );
}

/** Organization + workspace switcher. Switching is validated by the API (PUT /v1/me/context). */
function ContextSwitcher() {
  const ctx = useContextSafe();
  const router = useRouter();
  const reset = useResetCache();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const orgs = useQuery({ queryKey: keys.organizations, queryFn: () => http.get<{ data: OrganizationView[] }>('/v1/organizations'), enabled: open });
  const workspaces = useQuery({
    queryKey: keys.workspaces(ctx?.organization?.id ?? ''),
    queryFn: () => http.get<{ data: WorkspaceView[] }>(`/v1/organizations/${ctx!.organization!.id}/workspaces`),
    enabled: open && !!ctx?.organization,
  });

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  if (!ctx?.organization) return null;

  async function switchTo(organizationId: string, workspaceId: string | null) {
    try {
      await http.put('/v1/me/context', { organizationId, workspaceId });
      setOpen(false);
      await reset();
      router.push('/dashboard');
    } catch {
      toast('danger', 'You no longer have access to that workspace.');
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex w-full items-center gap-3 rounded-control border border-line px-3 py-2 text-left hover:bg-surface-muted"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{ctx.organization.name}</span>
          <span className="block truncate text-xs text-ink-muted">{ctx.workspace?.name ?? 'No workspace selected'}</span>
        </span>
        <ChevronsUpDown className="size-4 text-ink-faint" aria-hidden />
      </button>
      {open && (
        <div className="absolute inset-x-0 z-30 mt-1 max-h-96 overflow-auto rounded-control border border-line bg-surface p-1 shadow-lg">
          <p className="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-ink-faint">Workspaces</p>
          {(workspaces.data?.data ?? [])
            .filter((w) => w.status === 'active')
            .map((w) => (
              <button key={w.id} type="button" onClick={() => switchTo(ctx.organization!.id, w.id)} className="flex w-full items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-surface-muted">
                <span className="truncate">{w.name}</span>
                {w.id === ctx.workspace?.id && <Check className="size-4 text-accent" aria-label="current" />}
              </button>
            ))}
          <Link href="/workspaces" className="block rounded px-2 py-1.5 text-sm text-accent hover:bg-surface-muted" onClick={() => setOpen(false)}>
            Manage workspaces
          </Link>
          <hr className="my-1 border-line" />
          <p className="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-ink-faint">Organizations</p>
          {(orgs.data?.data ?? []).map((o) => (
            <button key={o.id} type="button" onClick={() => switchTo(o.id, null)} className="flex w-full items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-surface-muted">
              <span className="truncate">{o.name}</span>
              {o.id === ctx.organization!.id && <Check className="size-4 text-accent" aria-label="current" />}
            </button>
          ))}
          <Link href="/organizations" className="block rounded px-2 py-1.5 text-sm text-accent hover:bg-surface-muted" onClick={() => setOpen(false)}>
            All organizations
          </Link>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const ctx = useContextSafe();
  const router = useRouter();
  const reset = useResetCache();
  if (!ctx) return null;
  return (
    <div className="flex items-center gap-3 rounded-control border-t border-line px-2 pt-3">
      <Avatar name={ctx.user.displayName} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{ctx.user.displayName}</p>
        <p className="truncate text-xs text-ink-muted">{ctx.user.email}</p>
      </div>
      <button
        type="button"
        aria-label="Sign out"
        title="Sign out"
        className="rounded-control p-2 text-ink-muted hover:bg-surface-muted hover:text-ink"
        onClick={async () => {
          await http.post('/v1/auth/logout').catch(() => undefined);
          await reset();
          router.replace('/login');
        }}
      >
        <LogOut className="size-4" />
      </button>
    </div>
  );
}
