import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

const email = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email({ error: 'Enter a valid email address' }));

const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, { error: `Use at least ${PASSWORD_MIN_LENGTH} characters` })
  .max(PASSWORD_MAX_LENGTH, { error: `Use at most ${PASSWORD_MAX_LENGTH} characters` });

const token = z.string().min(20).max(200);

export const registerRequest = z.object({
  email,
  password,
  displayName: z.string().trim().min(1, { error: 'Enter your name' }).max(100),
});
export type RegisterRequest = z.infer<typeof registerRequest>;

export const loginRequest = z.object({
  email,
  password: z.string().min(1, { error: 'Enter your password' }).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const verifyEmailRequest = z.object({ token });
export const resendVerificationRequest = z.object({ email });
export const forgotPasswordRequest = z.object({ email });
export const resetPasswordRequest = z.object({ token, password });
export const changePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: password,
});
export const updateProfileRequest = z.object({ displayName: z.string().trim().min(1).max(100) });

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
}

export interface SessionSummary {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface SecurityEventView {
  id: string;
  type: string;
  occurredAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}
