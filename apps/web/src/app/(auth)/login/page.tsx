import { Suspense } from 'react';
import { workeasy360SignIn } from '@/lib/workeasy360';
import { LoginForm } from './login-form';

// WORKEASY360_SIGN_IN is read when the page is served, not frozen into the build: one image serves every deployment.
export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm workeasy360={workeasy360SignIn()} />
    </Suspense>
  );
}
