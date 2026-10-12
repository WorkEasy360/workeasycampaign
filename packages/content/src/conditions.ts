import type { ConditionOp, MergeDataV2 } from '@workeasy/shared';

/**
 * Dynamic-content conditions (docs/contracts/phase-7-content-amendment.md §C, C12). Pure data evaluation: no code, no
 * database access, no locale dependence. A value is "set" when it is non-blank; comparisons are trimmed and
 * case-insensitive (`toLowerCase`, locale-independent); a value that is not set equals and contains nothing.
 */
export interface ConditionLike {
  match: 'all' | 'any';
  rules: readonly { field: string; op: ConditionOp; value?: string }[];
}

const norm = (s: string) => s.trim().toLowerCase();

export function evaluateRule(rule: ConditionLike['rules'][number], data: MergeDataV2): boolean {
  const raw = data[rule.field];
  const set = raw != null && raw.trim() !== '';
  const value = norm(rule.value ?? '');
  switch (rule.op) {
    case 'is_set':
      return set;
    case 'is_not_set':
      return !set;
    case 'equals':
      return set && norm(raw!) === value;
    case 'not_equals':
      return !(set && norm(raw!) === value);
    case 'contains':
      return set && value !== '' && norm(raw!).includes(value);
    case 'not_contains':
      return !(set && value !== '' && norm(raw!).includes(value));
    default:
      return false; // an unknown op never shows content (fail closed)
  }
}

/** `all` of no rules is true and `any` of no rules is false (only a draft can have no rules). */
export function evaluateCondition(c: ConditionLike, data: MergeDataV2): boolean {
  return c.match === 'any' ? c.rules.some((r) => evaluateRule(r, data)) : c.rules.every((r) => evaluateRule(r, data));
}
