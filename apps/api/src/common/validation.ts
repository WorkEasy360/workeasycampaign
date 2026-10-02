import type { z } from 'zod';
import { Errors } from './errors.js';

/** Validate untrusted input against a shared contract. Server-side validation is the authoritative one. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  const fields: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length ? issue.path.join('.') : '_';
    (fields[key] ??= []).push(issue.message);
  }
  throw Errors.validation(fields);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route ids that are not UUIDs can never match anything: answer 404, not 400, so ids reveal nothing. */
export function routeId(value: string | undefined, what = 'Resource'): string {
  if (!value || !UUID_RE.test(value)) throw Errors.notFound(what);
  return value.toLowerCase();
}
