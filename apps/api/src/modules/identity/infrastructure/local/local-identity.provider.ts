import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { type Database, isUniqueViolation } from '@workeasy/db';
import type { IdentityStore } from '@workeasy/db/identity';
import { v7 as uuidv7 } from 'uuid';
import type { AppConfig } from '../../../../config/env.js';
import { Errors } from '../../../../common/errors.js';
import type { RequestMeta } from '../../../../common/request-context.js';
import { MAILER, type Mailer } from '../../../../infrastructure/mail/mailer.js';
import { Mail } from '../../../../infrastructure/mail/templates.js';
import { APP_CONFIG, DATABASE } from '../../../../infrastructure/providers.js';
import { hashToken, newToken } from '../../../../infrastructure/tokens.js';
import type { Credentials, ExternalIdentity, IdentityProvider } from '../../application/identity-provider.js';
import type { AuthenticatedPrincipal } from '../../domain/principal.js';
import { dummyPasswordHash, hashPassword, needsRehash, passwordProblems, verifyPassword } from './password.js';

export const IDENTITY_STORE = Symbol('IDENTITY_STORE');
export const LOCAL_PROVIDER_ID = 'local';

/** Throttling policy, evaluated over the append-only login_attempts ledger. */
export const LOGIN_THROTTLE = {
  windowMinutes: 15,
  /** Failures for one email (since its last success) before the account is temporarily locked. */
  maxFailuresPerAccount: 5,
  /** Failures from one IP across all emails (credential stuffing). */
  maxFailuresPerIp: 30,
} as const;

const TOKEN_TTL = { verify_email: 24 * 3600, reset_password: 3600 } as const;
type TokenPurpose = keyof typeof TOKEN_TTL;

const normalize = (email: string) => email.trim().toLowerCase();

/**
 * Local (email + password) identity provider. Owns the `identity` schema and nothing else.
 * Everything here becomes dead code when Workeasy SSO is the configured provider.
 */
@Injectable()
export class LocalIdentityProvider implements IdentityProvider, OnModuleDestroy {
  readonly id = LOCAL_PROVIDER_ID;

  constructor(
    @Inject(IDENTITY_STORE) private readonly store: IdentityStore,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleDestroy() {
    await this.store.disconnect();
  }

  // ─── IdentityProvider ──────────────────────────────────────────────────────────────────────────────────────

  async authenticate(credentials: Credentials, meta: RequestMeta): Promise<ExternalIdentity> {
    if (credentials.kind !== 'password') throw Errors.invalidCredentials();
    const email = normalize(credentials.email);
    await this.assertNotThrottled(email, meta.ipAddress);

    const account = await this.store.accounts.findUnique({ where: { emailNormalized: email } });
    // Always run one Argon2 verification so response time does not reveal whether the account exists.
    const ok = await verifyPassword(account?.passwordHash ?? (await dummyPasswordHash()), credentials.password);

    if (!account || !ok || account.status !== 'active') {
      await this.store.loginAttempts.create({ data: { emailNormalized: email, ipAddress: meta.ipAddress, succeeded: false } });
      await this.db.system.recordSecurityEvent({
        userId: null,
        type: 'auth.login_failed',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        correlationId: meta.requestId,
        metadata: { emailHash: hashToken(email).slice(0, 16) },
      });
      throw Errors.invalidCredentials();
    }

    await this.store.loginAttempts.create({ data: { emailNormalized: email, ipAddress: meta.ipAddress, succeeded: true } });
    if (needsRehash(account.passwordHash)) {
      await this.store.accounts.update({ where: { id: account.id }, data: { passwordHash: await hashPassword(credentials.password) } });
    }
    return {
      provider: this.id,
      subject: account.id,
      email: account.email,
      emailVerified: account.emailVerifiedAt !== null,
      displayName: null,
      authMethods: ['pwd'],
    };
  }

  async refresh(principal: AuthenticatedPrincipal): Promise<boolean> {
    const subject = await this.subjectFor(principal.userId);
    if (!subject) return false;
    const account = await this.store.accounts.findUnique({ where: { id: subject }, select: { status: true } });
    return account?.status === 'active';
  }

  async logout(): Promise<{ redirectUrl: string | null }> {
    return { redirectUrl: null }; // no upstream session for local accounts
  }

  // ─── Local-only flows ──────────────────────────────────────────────────────────────────────────────────────

  /** Always resolves the same way whether or not the email is registered (anti-enumeration). */
  async register(input: { email: string; password: string; displayName: string }, meta: RequestMeta): Promise<void> {
    const email = input.email.trim();
    const emailNormalized = normalize(email);
    const problems = passwordProblems(input.password, emailNormalized);
    if (problems.length) throw Errors.validation({ password: problems });

    const passwordHash = await hashPassword(input.password);
    const existing = await this.store.accounts.findUnique({ where: { emailNormalized } });
    if (existing) {
      await this.mailer.send(Mail.accountAlreadyExists(email, this.link('/login'), this.link('/forgot-password')));
      return;
    }

    const accountId = uuidv7();
    try {
      await this.store.accounts.create({ data: { id: accountId, email, emailNormalized, passwordHash } });
    } catch (err) {
      if (isUniqueViolation(err)) return; // concurrent registration of the same email: same outward result
      throw err;
    }

    let userId: string;
    try {
      userId = await this.db.system.linkIdentity({
        provider: this.id,
        subject: accountId,
        email,
        displayName: input.displayName,
        emailVerified: false,
      });
    } catch (err) {
      // The email belongs to a user of another identity provider: undo the local account, answer identically.
      await this.store.accounts.delete({ where: { id: accountId } });
      if (isUniqueViolation(err)) {
        await this.mailer.send(Mail.accountAlreadyExists(email, this.link('/login'), this.link('/forgot-password')));
        return;
      }
      throw err;
    }

    await this.securityEvent(userId, 'auth.registered', meta);
    await this.sendVerification(accountId, email, input.displayName, meta);
  }

  async resendVerification(emailInput: string, meta: RequestMeta): Promise<void> {
    const account = await this.store.accounts.findUnique({ where: { emailNormalized: normalize(emailInput) } });
    if (!account || account.emailVerifiedAt || account.status !== 'active') return;
    const recent = await this.store.tokens.count({
      where: { accountId: account.id, purpose: 'verify_email', createdAt: { gt: new Date(Date.now() - 3600_000) } },
    });
    if (recent >= 3) return; // silently capped; response is identical
    await this.sendVerification(account.id, account.email, account.email.split('@')[0]!, meta);
  }

  async verifyEmail(token: string, meta: RequestMeta): Promise<void> {
    const t = await this.consumeToken(token, 'verify_email');
    const account = await this.store.accounts.update({ where: { id: t.accountId }, data: { emailVerifiedAt: new Date() } });
    const userId = await this.db.system.linkIdentity({
      provider: this.id,
      subject: account.id,
      email: account.email,
      displayName: account.email.split('@')[0]!,
      emailVerified: true,
    });
    await this.securityEvent(userId, 'auth.email_verified', meta);
  }

  async requestPasswordReset(emailInput: string, meta: RequestMeta): Promise<void> {
    const account = await this.store.accounts.findUnique({ where: { emailNormalized: normalize(emailInput) } });
    if (!account || account.status !== 'active') return;
    const recent = await this.store.tokens.count({
      where: { accountId: account.id, purpose: 'reset_password', createdAt: { gt: new Date(Date.now() - 3600_000) } },
    });
    if (recent >= 3) return;
    // Only the newest reset link works.
    await this.store.tokens.updateMany({
      where: { accountId: account.id, purpose: 'reset_password', consumedAt: null },
      data: { consumedAt: new Date() },
    });
    const token = await this.issueToken(account.id, 'reset_password', meta);
    await this.mailer.send(Mail.resetPassword(account.email, this.link(`/reset-password?token=${token}`)));
  }

  /** Returns the platform user id; the caller revokes every session (a reset proves inbox control only). */
  async resetPassword(token: string, password: string, meta: RequestMeta): Promise<string> {
    const t = await this.peekToken(token, 'reset_password');
    const account = await this.store.accounts.findUniqueOrThrow({ where: { id: t.accountId } });
    const problems = passwordProblems(password, account.emailNormalized);
    if (problems.length) throw Errors.validation({ password: problems });
    await this.consumeToken(token, 'reset_password');
    const now = new Date();
    await this.store.accounts.update({
      where: { id: account.id },
      data: { passwordHash: await hashPassword(password), passwordChangedAt: now, emailVerifiedAt: account.emailVerifiedAt ?? now },
    });
    const userId = await this.db.system.linkIdentity({
      provider: this.id,
      subject: account.id,
      email: account.email,
      displayName: account.email.split('@')[0]!,
      emailVerified: true,
    });
    await this.securityEvent(userId, 'auth.password_reset', meta);
    await this.mailer.send(Mail.passwordChanged(account.email));
    return userId;
  }

  async changePassword(principal: AuthenticatedPrincipal, current: string, next: string, meta: RequestMeta): Promise<void> {
    const subject = await this.subjectFor(principal.userId);
    const account = subject ? await this.store.accounts.findUnique({ where: { id: subject } }) : null;
    if (!account) throw Errors.precondition('Your account does not use a password');
    if (!(await verifyPassword(account.passwordHash, current))) {
      throw Errors.validation({ currentPassword: ['Current password is incorrect'] });
    }
    const problems = passwordProblems(next, account.emailNormalized);
    if (current === next) problems.push('Choose a password you have not used here before');
    if (problems.length) throw Errors.validation({ newPassword: problems });
    await this.store.accounts.update({
      where: { id: account.id },
      data: { passwordHash: await hashPassword(next), passwordChangedAt: new Date() },
    });
    await this.securityEvent(principal.userId, 'auth.password_changed', meta);
    await this.mailer.send(Mail.passwordChanged(account.email));
  }

  // ─── internals ─────────────────────────────────────────────────────────────────────────────────────────────

  private async assertNotThrottled(email: string, ip: string | null): Promise<void> {
    const since = new Date(Date.now() - LOGIN_THROTTLE.windowMinutes * 60_000);
    const lastSuccess = await this.store.loginAttempts.findFirst({
      where: { emailNormalized: email, succeeded: true, attemptedAt: { gt: since } },
      orderBy: { attemptedAt: 'desc' },
      select: { attemptedAt: true },
    });
    const accountFailures = await this.store.loginAttempts.findMany({
      where: { emailNormalized: email, succeeded: false, attemptedAt: { gt: lastSuccess?.attemptedAt ?? since } },
      orderBy: { attemptedAt: 'asc' },
      select: { attemptedAt: true },
    });
    if (accountFailures.length >= LOGIN_THROTTLE.maxFailuresPerAccount) {
      const oldest = accountFailures[0]!.attemptedAt.getTime();
      throw Errors.accountLocked(Math.max(1, Math.ceil((oldest + LOGIN_THROTTLE.windowMinutes * 60_000 - Date.now()) / 1000)));
    }
    if (ip) {
      const ipFailures = await this.store.loginAttempts.count({
        where: { ipAddress: ip, succeeded: false, attemptedAt: { gt: since } },
      });
      if (ipFailures >= LOGIN_THROTTLE.maxFailuresPerIp) throw Errors.rateLimited(LOGIN_THROTTLE.windowMinutes * 60);
    }
  }

  private async subjectFor(userId: string): Promise<string | null> {
    const identity = await this.db.asUser(userId, (tx) =>
      tx.userIdentity.findFirst({ where: { userId, provider: this.id }, select: { subject: true } }),
    );
    return identity?.subject ?? null;
  }

  private async sendVerification(accountId: string, email: string, name: string, meta: RequestMeta) {
    const token = await this.issueToken(accountId, 'verify_email', meta);
    await this.mailer.send(Mail.verifyEmail(email, name, this.link(`/verify-email?token=${token}`)));
  }

  private async issueToken(accountId: string, purpose: TokenPurpose, meta: RequestMeta): Promise<string> {
    const token = newToken();
    await this.store.tokens.create({
      data: {
        accountId,
        purpose,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + TOKEN_TTL[purpose] * 1000),
        requestedIp: meta.ipAddress,
      },
    });
    return token;
  }

  private async peekToken(token: string, purpose: TokenPurpose) {
    const t = await this.store.tokens.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!t || t.purpose !== purpose || t.consumedAt || t.expiresAt.getTime() <= Date.now()) throw Errors.tokenInvalid();
    return t;
  }

  /** Single use, enforced atomically: the conditional update succeeds for exactly one caller. */
  private async consumeToken(token: string, purpose: TokenPurpose) {
    const t = await this.peekToken(token, purpose);
    const r = await this.store.tokens.updateMany({ where: { id: t.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (r.count !== 1) throw Errors.tokenInvalid();
    return t;
  }

  private securityEvent(userId: string, type: string, meta: RequestMeta) {
    return this.db.system.recordSecurityEvent({
      userId,
      type,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      correlationId: meta.requestId,
    });
  }

  private link(path: string) {
    return `${this.config.appUrl}${path}`;
  }
}
