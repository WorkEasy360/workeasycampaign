'use client';

import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { AppShell } from '@/components/app-shell';
import { Spinner } from '@/components/ui';
import { ContextProvider, useCurrentContext, useSession } from '@/lib/session';

/**
 * Gate for the signed-in app. Purely a UX router — every API call is authorized by the server regardless.
 *   no session → /login   ·   unverified email → /verify-email   ·   no organization → /onboarding
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const session = useSession();
  const user = session.data?.user;
  const context = useCurrentContext(!!user?.emailVerified);

  useEffect(() => {
    if (session.isLoading) return;
    if (!user) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    else if (!user.emailVerified) router.replace('/verify-email');
    else if (context.data && !context.data.organization && pathname !== '/organizations') router.replace('/onboarding');
  }, [session.isLoading, user, context.data, pathname, router]);

  if (!user?.emailVerified || !context.data) return <Spinner />;
  if (!context.data.organization && pathname !== '/organizations') return <Spinner />;

  return (
    <ContextProvider value={context.data}>
      <AppShell>{children}</AppShell>
    </ContextProvider>
  );
}
