'use client';

import { useState } from 'react';
import type { z } from 'zod';
import { ApiError } from './api';

/**
 * Form state helper: validates with the SAME shared Zod contract the API uses (instant feedback), then shows the
 * server's field errors if it disagrees. The server remains authoritative.
 */
export function useForm<S extends z.ZodType>(schema: S) {
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(values: unknown, action: (data: z.output<S>) => Promise<void>) {
    setFormError(null);
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      const errs: Record<string, string[]> = {};
      for (const i of parsed.error.issues) (errs[i.path.join('.') || '_'] ??= []).push(i.message);
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      await action(parsed.data);
    } catch (err) {
      if (err instanceof ApiError) {
        if (Object.keys(err.fields).length) setFieldErrors(err.fields);
        setFormError(err.message);
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return { fieldErrors, formError, submitting, submit, setFormError };
}

export function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
}
