import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/lib/session';
import { ssoErrorMessage, workeasy360SignIn } from '@/lib/workeasy360';
import { LoginForm } from './login-form';
import LoginPage from './page';

let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}));

beforeEach(() => {
  search = '';
});

describe('sign-in with WorkEasy360', () => {
  it('is not offered unless WORKEASY360_SIGN_IN says so', () => {
    expect(workeasy360SignIn(undefined)).toBe('off');
    expect(workeasy360SignIn('ON')).toBe('on');
    expect(workeasy360SignIn('only')).toBe('only');
    expect(workeasy360SignIn('yes')).toBe('off');
    render(
      <Providers>
        <LoginPage />
      </Providers>,
    );
    expect(screen.queryByRole('link', { name: 'Continue with WorkEasy360' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('offers it next to the password form, keeping a safe destination', () => {
    search = 'next=/campaigns';
    render(
      <Providers>
        <LoginForm workeasy360="on" />
      </Providers>,
    );
    expect(screen.getByRole('link', { name: 'Continue with WorkEasy360' })).toHaveAttribute('href', '/api/v1/auth/workeasy360/start?next=%2Fcampaigns');
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('never forwards an unsafe destination', () => {
    search = 'next=//evil.example';
    render(
      <Providers>
        <LoginForm workeasy360="on" />
      </Providers>,
    );
    expect(screen.getByRole('link', { name: 'Continue with WorkEasy360' })).toHaveAttribute('href', '/api/v1/auth/workeasy360/start?next=%2Fdashboard');
  });

  it('SSO-only: no password form, no registration link', () => {
    render(
      <Providers>
        <LoginForm workeasy360="only" />
      </Providers>,
    );
    expect(screen.getByRole('link', { name: 'Continue with WorkEasy360' })).toHaveAttribute('href', '/api/v1/auth/workeasy360/start');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create an account' })).not.toBeInTheDocument();
  });

  it('explains a sign-in that did not complete, with the entitlement reason', () => {
    search = 'sso_error=not_entitled&reason=expired';
    render(
      <Providers>
        <LoginForm workeasy360="on" />
      </Providers>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent("Your organization's Workeasy Campaign subscription has ended");
    expect(ssoErrorMessage('account_exists')).toMatch(/already exists here/);
    expect(ssoErrorMessage('something-new')).toBe(ssoErrorMessage('refused'));
  });
});
