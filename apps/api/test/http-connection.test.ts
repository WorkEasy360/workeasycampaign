import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Agent, createOrg, resetTestDatabase, signUp, startTestApp, type TestApp } from './support.js';

/**
 * Regression (found by the Phase 6 E2E suite, 2026-10-08): an upload rejected while streaming (FILE_TOO_LARGE → 413)
 * was answered before its body was fully received, and the server kept "draining" the declared remainder. A client
 * (the web proxy) that stopped sending on the early answer but reused the keep-alive socket had its NEXT request
 * swallowed as that remainder — it hung (the E2E registration right after the Phase 5 oversize-upload test).
 * The API now closes connections whose request body was not completely received when an error is sent.
 */
describe('early error responses close half-read connections', () => {
  let t: TestApp;
  let port: number;
  let owner: Agent;
  let ws: string;
  beforeAll(async () => {
    await resetTestDatabase();
    t = await startTestApp({ IMPORT_MAX_BYTES: String(64 * 1024) });
    owner = await signUp(t, undefined, 'Uploader');
    ws = (await createOrg(owner, 'Upload Co')).workspaceId;
    await owner.get('/v1/auth/csrf');
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    port = (t.app.getHttpServer().address() as AddressInfo).port;
  });
  afterAll(async () => t?.close());

  const cookieHeader = () => [...((owner as unknown as { cookies: Map<string, string> }).cookies)].map(([k, v]) => `${k}=${v}`).join('; ');

  it('an upload rejected mid-stream (413) closes the connection; a follow-up request on that socket is never swallowed', async () => {
    const declared = 1024 * 1024; // the client announces 1 MB …
    const sent = 200 * 1024; // … sends 200 KB (over the 64 KB limit), then stops — like the proxy after the early 413
    const result = await new Promise<{ first: string; second: boolean; closed: boolean }>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      let data = '';
      let phase: 'first' | 'second' = 'first';
      let closed = false;
      const finish = () => resolve({ first: data.split('\r\n\r\n')[0] ?? '', second: (data.match(/HTTP\/1\.1 /g) ?? []).length >= 2, closed });
      const timer = setTimeout(() => {
        socket.destroy();
        finish();
      }, 5_000);
      socket.on('data', (d) => {
        data += d.toString('latin1');
        if (phase === 'first' && /HTTP\/1\.1 \d{3}[\s\S]*\r\n\r\n/.test(data)) {
          phase = 'second';
          // reuse the same keep-alive socket for the next request (what a pooling proxy does)
          setTimeout(() => socket.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n', () => undefined), 100);
        }
        if ((data.match(/HTTP\/1\.1 /g) ?? []).length >= 2) {
          clearTimeout(timer);
          socket.destroy();
          finish();
        }
      });
      socket.on('end', () => {
        closed = true;
        clearTimeout(timer);
        socket.destroy();
        finish();
      });
      socket.on('error', (e) => {
        if (data) {
          closed = true;
          clearTimeout(timer);
          finish();
        } else reject(e);
      });
      socket.write(
        `POST /v1/workspaces/${ws}/imports?fileName=big.csv HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/csv\r\nContent-Length: ${declared}\r\n` +
          `Cookie: ${cookieHeader()}\r\nX-CSRF-Token: ${owner.cookie('wk_csrf')}\r\nOrigin: http://localhost:3000\r\nConnection: keep-alive\r\n\r\n`,
      );
      socket.write(Buffer.from(`Email\n${'a@example.test\n'.repeat(Math.ceil(sent / 14))}`.slice(0, sent)));
    });
    expect(result.first).toMatch(/^HTTP\/1\.1 413/);
    // Either the server closed the half-read connection (the fix), or it answered the next request — never a hang.
    expect(result.closed || result.second).toBe(true);
    expect(result.first.toLowerCase()).toContain('connection: close');
  }, 30_000);

  it('a complete request keeps its keep-alive connection (no needless closes)', async () => {
    const r = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      let data = '';
      socket.on('data', (d) => {
        data += d.toString('latin1');
        if (data.includes('\r\n\r\n')) {
          socket.destroy();
          resolve(data);
        }
      });
      socket.on('error', reject);
      socket.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
    });
    expect(r).toMatch(/^HTTP\/1\.1 200/);
    expect(r.toLowerCase()).not.toContain('connection: close');
  });
});
