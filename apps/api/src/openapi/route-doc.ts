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
}
