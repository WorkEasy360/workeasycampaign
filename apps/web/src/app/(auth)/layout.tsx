import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from '@/components/brand';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <Link href="/login" className="mb-8">
        <Logo />
      </Link>
      <div className="w-full max-w-md rounded-card border border-line bg-surface p-6 shadow-sm sm:p-8">{children}</div>
      <p className="mt-8 text-center text-xs text-ink-faint">Email, SMS and WhatsApp campaigns — one place for every customer conversation.</p>
    </main>
  );
}
