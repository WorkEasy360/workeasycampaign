import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ToastProvider } from '@/components/ui';
import { Providers } from '@/lib/session';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Workeasy Campaign', template: '%s · Workeasy Campaign' },
  description: 'Customer engagement and marketing automation across email, SMS and WhatsApp.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <ToastProvider>{children}</ToastProvider>
        </Providers>
      </body>
    </html>
  );
}
