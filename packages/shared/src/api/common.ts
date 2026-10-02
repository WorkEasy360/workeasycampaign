import { z } from 'zod';

/** Every error response from the API has this shape. */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Field-level validation issues, keyed by dotted path. */
    fields?: Record<string, string[]>;
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
