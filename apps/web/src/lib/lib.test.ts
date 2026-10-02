import { describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import { describeUserAgent, humanizeAction, initials } from './format';
import { safeNext } from './navigation';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('safeNext (open-redirect protection)', () => {
  it.each([
    ['/settings/members', '/settings/members'],
    ['/invitations/accept?token=abc', '/invitations/accept?token=abc'],
    ['https://evil.example/', '/dashboard'],
    ['//evil.example/path', '/dashboard'],
    ['/\\evil.example', '/dashboard'],
    ['javascript:alert(1)', '/dashboard'],
    [null, '/dashboard'],
  ])('%s → %s', (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });
});

describe('api client', () => {
  it('sends the CSRF cookie value as a header on unsafe requests', async () => {
    document.cookie = 'wk_csrf=token-123; path=/';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { ok: true }));
    await api('POST', '/v1/x', { body: {} });
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('token-123');
    expect(fetchMock.mock.calls[0]![1]!.credentials).toBe('same-origin');
  });

  it('refreshes a stale CSRF token and retries exactly once', async () => {
    document.cookie = 'wk_csrf=stale; path=/';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(403, { error: { code: 'csrf_failed', message: 'x', requestId: 'r' } }))
      .mockResolvedValueOnce(json(200, { csrfToken: 'fresh' }))
      .mockResolvedValueOnce(json(403, { error: { code: 'csrf_failed', message: 'still bad', requestId: 'r' } }))
      .mockResolvedValueOnce(json(403, { error: { code: 'csrf_failed', message: 'x', requestId: 'r' } }));
    await expect(api('POST', '/v1/x', { body: {} })).rejects.toMatchObject({ code: 'csrf_failed' });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(['/api/v1/x', '/api/v1/auth/csrf', '/api/v1/x']);
  });

  it('maps API errors, including field errors, to ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(400, { error: { code: 'validation_failed', message: 'Fix it', fields: { email: ['bad'] }, requestId: 'req-1' } }),
    );
    const err = (await api('GET', '/v1/x').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'validation_failed', fields: { email: ['bad'] }, requestId: 'req-1' });
  });

  it('reports network failures in plain language', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api('GET', '/v1/x')).rejects.toMatchObject({ code: 'network_error', status: 0 });
  });
});

describe('formatting', () => {
  it('formats names, actions and devices for people', () => {
    expect(initials('Ada Lovelace King')).toBe('AL');
    expect(humanizeAction('member.role_changed')).toBe('Member role changed');
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/140 Safari/537')).toBe('Chrome on Windows');
    expect(describeUserAgent(null)).toBe('Unknown device');
  });
});
