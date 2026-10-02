import type { ApiErrorCode } from '@workeasy/shared';

/** The only error type services throw on purpose. Everything else is reported as internal_error. */
export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    message: string,
    readonly fields?: Record<string, string[]>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  validation: (fields: Record<string, string[]>, message = 'Some fields need attention') =>
    new AppError('validation_failed', 400, message, fields),
  unauthenticated: (message = 'Sign in to continue') => new AppError('unauthenticated', 401, message),
  csrf: () => new AppError('csrf_failed', 403, 'Your session security token is missing or expired. Reload and try again.'),
  forbidden: (message = 'You do not have permission to do this') => new AppError('forbidden', 403, message),
  /** Also used when the caller is not a member: we never confirm that another tenant's resource exists. */
  notFound: (what = 'Resource') => new AppError('not_found', 404, `${what} not found`),
  conflict: (message: string, fields?: Record<string, string[]>) => new AppError('conflict', 409, message, fields),
  versionConflict: () =>
    new AppError('version_conflict', 409, 'Someone else changed this in the meantime. Reload to see the latest version.'),
  precondition: (message: string) => new AppError('precondition_failed', 422, message),
  emailNotVerified: () => new AppError('email_not_verified', 403, 'Verify your email address first'),
  invalidCredentials: () => new AppError('invalid_credentials', 401, 'Email or password is incorrect'),
  accountLocked: (retryAfterSeconds: number) =>
    new AppError('account_locked', 429, 'Too many failed attempts. Try again later or reset your password.', undefined, {
      'Retry-After': String(retryAfterSeconds),
    }),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError('rate_limited', 429, 'Too many requests. Slow down and try again shortly.', undefined, {
      'Retry-After': String(retryAfterSeconds),
    }),
  tokenInvalid: (message = 'This link is invalid or has expired') => new AppError('token_invalid', 400, message),
  idempotencyConflict: () =>
    new AppError('idempotency_conflict', 422, 'This Idempotency-Key was already used for a different request'),
};
