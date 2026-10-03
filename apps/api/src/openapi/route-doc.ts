import type { z } from 'zod';

export interface RouteDoc {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  tag: string;
  summary: string;
  /** public | user | organization:<permission|member> | workspace:<permission|member> */
  access: string;
  body?: z.ZodType;
  query?: z.ZodType;
  success: number;
  idempotent?: boolean;
  /** JSON Schema of the success body, for contracts other services depend on (e.g. eligibility). */
  response?: Record<string, unknown>;
  /** Route-specific error statuses worth knowing, beyond the generic 400/401/403/404 (status → meaning). */
  errors?: Record<number, string>;
  /** Raw request media type instead of a JSON body (e.g. CSV uploads). */
  requestContentType?: 'text/csv';
  /** Non-JSON success body (e.g. CSV downloads). */
  responseContentType?: 'text/csv';
}
