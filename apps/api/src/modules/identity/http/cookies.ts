import type { FastifyReply } from 'fastify';
import type { AppConfig } from '../../../config/env.js';
import { SESSION_POLICY } from '../application/session.service.js';

/**
 * Session cookie: HttpOnly (no script access), SameSite=Lax (not sent on cross-site subrequests/POSTs),
 * Secure + __Host- prefix in production (HTTPS only, host-locked, Path=/). Max-Age = absolute session lifetime;
 * the server enforces idle/absolute expiry independently.
 */
export function setSessionCookie(reply: FastifyReply, config: AppConfig, token: string): void {
  reply.setCookie(config.cookies.sessionName, token, {
    httpOnly: true,
    secure: config.cookies.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_POLICY.absoluteSeconds,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(config.cookies.sessionName, { path: '/', secure: config.cookies.secure, sameSite: 'lax', httpOnly: true });
}

/** CSRF cookie is readable by our own scripts by design (double-submit); it is useless without the session. */
export function setCsrfCookie(reply: FastifyReply, config: AppConfig, token: string): void {
  reply.setCookie(config.cookies.csrfName, token, {
    httpOnly: false,
    secure: config.cookies.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_POLICY.absoluteSeconds,
  });
}
