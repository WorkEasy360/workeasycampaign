import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/lib/session';
import LoginPage from './page';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams('next=/settings/members'),
}));

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => replace.mockReset());

function renderLogin() {
  render(
    <Providers>
      <LoginPage />
    </Providers>,
  );
}

describe('login page', () => {
  it('validates on the client before calling the API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    renderLogin();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the server message on bad credentials without revealing which part was wrong', async () => {
    document.cookie = 'wk_csrf=t; path=/';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(401, { error: { code: 'invalid_credentials', message: 'Email or password is incorrect', requestId: 'r' } }));
    renderLogin();
    await userEvent.type(await screen.findByLabelText('Work email'), 'sam@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect');
    expect(replace).not.toHaveBeenCalled();
  });

  it('continues to the safe "next" destination after signing in', async () => {
    document.cookie = 'wk_csrf=t; path=/';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/v1/auth/login')
        ? json(200, { user: { id: 'u', email: 'sam@example.com', displayName: 'Sam', emailVerified: true }, csrfToken: 'n' })
        : json(200, { user: null }),
    );
    renderLogin();
    await userEvent.type(await screen.findByLabelText('Work email'), 'sam@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'maple-river-lantern');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith('/settings/members'));
  });
});
