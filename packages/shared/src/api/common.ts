import { z } from 'zod';
import type { ReadinessFinding } from '../campaigns.js';

/** Every error response from the API has this shape. */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Field-level validation issues, keyed by dotted path. */
    fields?: Record<string, string[]>;
    /** Only with PREFLIGHT_FAILED / PREFLIGHT_UNAVAILABLE: the blocking pre-flight findings (never personal data). */
    findings?: ReadinessFinding[];
    requestId: string;
  };
}

export const API_ERROR_CODES = [
  'validation_failed',
  'unauthenticated',
  'csrf_failed',
  'forbidden',
  'not_found',
  'conflict',
  'version_conflict',
  'rate_limited',
  'email_not_verified',
  'invalid_credentials',
  'account_locked',
  'token_invalid',
  'idempotency_conflict',
  'precondition_failed',
  'internal_error',
  // Campaign domain codes (docs/contracts/phase-6-campaign.md §15), added for Phase 6. Codes are added, never renamed.
  'INVALID_TRANSITION',
  'CAMPAIGN_NOT_EDITABLE',
  'CAMPAIGN_ACTIVE',
  'CHANNEL_NOT_AVAILABLE',
  'DELIVERY_NOT_AVAILABLE',
  'PREFLIGHT_FAILED',
  // 6.7 degraded mode (2026-10-07): the audience cannot be resolved within the interactive budget right now; recovery
  // was requested; retry (409, nothing written). See contract §3.3.
  'PREFLIGHT_UNAVAILABLE',
  // Phase 7.3: the delivery provider did not accept a test send (retryable; nothing about the campaign changed).
  'TEST_SEND_FAILED',
  // Gate D/G: a required shared dependency (the rate-limit store) is unreachable; retry later (503 + Retry-After).
  'service_unavailable',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuery>;

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export const uuid = z.uuid();
