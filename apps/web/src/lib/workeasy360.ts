/**
 * Sign-in with WorkEasy360 Accounts, as the web app shows it (docs/workeasy360-sso.md). The API does the work; the
 * web only links to the start route, explains a failed sign-in and offers "Sign out of WorkEasy360 too".
 */

/** What the sign-in page offers: off (password only), on (both), only (WorkEasy360 only, with WORKEASY360_SSO_ONLY). */
export type Workeasy360SignIn = 'off' | 'on' | 'only';

/** Read on the web server at request time (WORKEASY360_SIGN_IN), so one image serves every deployment. */
export function workeasy360SignIn(raw: string | undefined = process.env.WORKEASY360_SIGN_IN): Workeasy360SignIn {
  const v = raw?.trim().toLowerCase();
  return v === 'on' || v === 'only' ? v : 'off';
}

/** The API route that starts the sign-in (a full-page navigation, never a fetch or a prefetched link). */
export function workeasy360StartUrl(next?: string): string {
  return `/api/v1/auth/workeasy360/start${next ? `?next=${encodeURIComponent(next)}` : ''}`;
}

const REASONS: Record<string, string> = {
  not_entitled: 'Your organization does not have Workeasy Campaign yet. An administrator can get it in the WorkEasy360 store.',
  expired: "Your organization's Workeasy Campaign subscription has ended. An administrator can renew it in WorkEasy360.",
  suspended: "Your organization's access to Workeasy Campaign is suspended. Contact your administrator.",
  membership_inactive: 'Your access to this organization has ended. Ask an administrator.',
  no_seat: 'You do not have a Workeasy Campaign seat. Ask an administrator for one.',
};

const MESSAGES: Record<string, string> = {
  not_configured: 'Sign-in with WorkEasy360 is not set up here yet.',
  expired: 'The sign-in took too long or was already used. Please try again.',
  unavailable: 'WorkEasy360 could not be reached. Try again in a minute.',
  rate_limited: 'Too many sign-ins right now. Try again in a minute.',
  cancelled: 'The sign-in was cancelled.',
  refused: 'WorkEasy360 did not complete the sign-in. Please try again.',
  invalid_token: 'The sign-in could not be verified. Please try again, or contact support if it keeps happening.',
  wrong_product: 'The sign-in could not be verified. Please try again, or contact support if it keeps happening.',
  no_organization: 'Choose an organization in WorkEasy360, then try again.',
  email_unverified: 'Verify your email address in WorkEasy360 first, then try again.',
  wrong_organization: 'WorkEasy360 signed you in for another organization than the one you opened. Open Workeasy Campaign again from WorkEasy360.',
  membership_inactive: 'Your membership of this organization has ended in WorkEasy360. Ask an administrator.',
  organization_inactive: 'This organization is not active in WorkEasy360.',
  integration_suspended: 'Sign-in with WorkEasy360 is temporarily unavailable for Workeasy Campaign.',
  access_policy_denied: "Your organization's sign-in policy does not allow this sign-in.",
  access_unverified: 'Workeasy Campaign cannot confirm your access with WorkEasy360 right now. Try again in a few minutes.',
  account_exists: 'An account with this email address already exists here. Sign in with your password, or ask support to link it to your WorkEasy360 account.',
  identity_conflict: 'Your WorkEasy360 account has to be moved over by support before you can sign in here.',
  account_disabled: 'This account is deactivated.',
  organization_unavailable: 'Your organization is not available in Workeasy Campaign. Contact support.',
  organization_not_linked: 'Your organization has not been set up in Workeasy Campaign yet. Contact support.',
  membership_suspended: 'Your access to this organization is suspended here. Ask an owner to reactivate it.',
};

/** One message per error code of the callback (a fixed vocabulary; anything else gets the generic message). */
export function ssoErrorMessage(code: string, reason?: string | null): string {
  if (code === 'not_entitled') return REASONS[reason ?? ''] ?? REASONS.not_entitled!;
  return MESSAGES[code] ?? MESSAGES.refused!;
}
