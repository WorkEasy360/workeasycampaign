import type { ApiErrorCode, ReadinessFinding } from '@workeasy/shared';

/** The only error type services throw on purpose. Everything else is reported as internal_error. */
export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    message: string,
    readonly fields?: Record<string, string[]>,
    readonly headers?: Record<string, string>,
    /** Only with PREFLIGHT_FAILED: the blocking findings (never personal data). */
    readonly findings?: ReadinessFinding[],
    /** Only with workeasy360_access_ended: WorkEasy360's entitlement reason. */
    readonly reason?: string,
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
  serviceUnavailable: (message: string, retryAfterSeconds = 5) =>
    new AppError('service_unavailable', 503, message, undefined, { 'Retry-After': String(retryAfterSeconds) }),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError('rate_limited', 429, 'Too many requests. Slow down and try again shortly.', undefined, {
      'Retry-After': String(retryAfterSeconds),
    }),
  tokenInvalid: (message = 'This link is invalid or has expired') => new AppError('token_invalid', 400, message),
  idempotencyConflict: () =>
    new AppError('idempotency_conflict', 422, 'This Idempotency-Key was already used for a different request'),
  // WorkEasy360 Accounts sign-in (docs/workeasy360-sso.md).
  workeasy360SignInRequired: () => new AppError('workeasy360_sign_in_required', 401, 'Sign in with WorkEasy360 to continue'),
  passwordSignInDisabled: () =>
    new AppError('password_sign_in_disabled', 403, 'Password sign-in is turned off. Continue with WorkEasy360 instead.'),
  workeasy360AccessEnded: (reason: string) =>
    new AppError('workeasy360_access_ended', 403, ACCESS_ENDED_MESSAGES[reason] ?? ACCESS_ENDED_MESSAGES.not_entitled!, undefined, undefined, undefined, reason),
  workeasy360ReadOnly: () =>
    new AppError('workeasy360_read_only', 403, 'Your organization can view its data but not make changes until its subscription is renewed.'),
  workeasy360AccessUnverified: () =>
    new AppError('workeasy360_access_unverified', 403, 'Workeasy Campaign cannot confirm your access with WorkEasy360 right now. Try again in a few minutes.'),
  workeasy360OrganizationManaged: () =>
    new AppError('workeasy360_organization_managed', 403, 'You signed in with WorkEasy360 for one organization. Organizations come from WorkEasy360: switch organization there.'),
};

/** What the person is told, per WorkEasy360 entitlement reason (integration guide §7). */
const ACCESS_ENDED_MESSAGES: Record<string, string> = {
  not_entitled: "Your organization does not have Workeasy Campaign. Get it in WorkEasy360's store.",
  expired: "Your organization's Workeasy Campaign subscription has ended. Renew it in WorkEasy360.",
  suspended: "Your organization's access to Workeasy Campaign is suspended. Contact your administrator.",
  read_only: "Your organization's subscription is read-only.",
  membership_inactive: 'Your access to this organization has ended. Ask an administrator.',
  no_seat: 'You do not have a Workeasy Campaign seat. Ask an administrator for one.',
};
