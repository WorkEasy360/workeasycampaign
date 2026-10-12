import { isMergeFieldNameV2, MERGE_TAG_FALLBACK_MAX, MERGE_TAG_NAMES, type MergeData, type MergeDataV2, type MergeTagName } from '@workeasy/shared';

/**
 * `merge_tags_v1` (docs/contracts/phase-6-content-amendment.md §3):
 *   {{ NAME }}  or  {{ NAME | "FALLBACK" }}
 * NAME from the closed allowlist; FALLBACK ≤ 100 chars without `"` or `}`. Any other `{{` is an error — there is no
 * escape syntax in v1. Substitution is a single pass: inserted values are text, never re-parsed as tags or markup.
 */
export type TemplatePart = { kind: 'text'; value: string } | { kind: 'tag'; name: MergeTagName; fallback: string | null };

export interface MergeTagError {
  /** Offset of the offending `{{` in the input. */
  index: number;
  reason: 'unknown_name' | 'malformed';
  message: string;
}

export interface ParsedTemplate {
  parts: TemplatePart[];
  errors: MergeTagError[];
}

const NAMES: ReadonlySet<string> = new Set(MERGE_TAG_NAMES);
const TAG = new RegExp(`^\\{\\{\\s*([A-Za-z0-9_.]+)\\s*(?:\\|\\s*"([^"}]{0,${MERGE_TAG_FALLBACK_MAX}})"\\s*)?\\}\\}`);

export function parseTemplate(input: string): ParsedTemplate {
  return parseWith(input, (name) => NAMES.has(name), `Use one of: ${MERGE_TAG_NAMES.join(', ')}`) as ParsedTemplate;
}

/**
 * `merge_tags_v2` (docs/contracts/phase-7-content-amendment.md §C, C13): v1's syntax and single-pass semantics with the
 * v2 names (`contact.custom.<key>`, `workspace.name`, `organization.name`). Whether a custom key exists is checked by
 * readiness, not here.
 */
export type TemplatePartV2 = { kind: 'text'; value: string } | { kind: 'tag'; name: string; fallback: string | null };
export interface ParsedTemplateV2 {
  parts: TemplatePartV2[];
  errors: MergeTagError[];
}
export function parseTemplateV2(input: string): ParsedTemplateV2 {
  return parseWith(input, isMergeFieldNameV2, 'Use a contact field (e.g. contact.first_name or contact.custom.your_field), workspace.name or organization.name');
}

/** Value of a v2 tag: the value if non-blank, else the fallback, else ''. */
export function tagValueV2(part: Extract<TemplatePartV2, { kind: 'tag' }>, data: MergeDataV2): string {
  const v = data[part.name];
  return v != null && v.trim() !== '' ? v : (part.fallback ?? '');
}

/** Valid v2 tag names used in `input`. */
export function tagsInV2(input: string): string[] {
  return parseTemplateV2(input).parts.flatMap((p) => (p.kind === 'tag' ? [p.name] : []));
}

function parseWith(input: string, isName: (name: string) => boolean, hint: string): ParsedTemplateV2 {
  const parts: TemplatePartV2[] = [];
  const errors: MergeTagError[] = [];
  let text = '';
  let i = 0;
  while (i < input.length) {
    const open = input.indexOf('{{', i);
    if (open < 0) {
      text += input.slice(i);
      break;
    }
    text += input.slice(i, open);
    const m = TAG.exec(input.slice(open));
    if (m && isName(m[1]!)) {
      if (text) parts.push({ kind: 'text', value: text });
      text = '';
      parts.push({ kind: 'tag', name: m[1]!, fallback: m[2] ?? null });
      i = open + m[0].length;
      continue;
    }
    errors.push(
      m
        ? { index: open, reason: 'unknown_name', message: `Unknown merge field "${m[1]}". ${hint}` }
        : { index: open, reason: 'malformed', message: 'Merge fields look like {{ contact.first_name }} or {{ contact.first_name | "there" }}' },
    );
    // Keep the literal text and continue after the braces, so one error does not hide the next.
    text += '{{';
    i = open + 2;
  }
  if (text) parts.push({ kind: 'text', value: text });
  return { parts, errors };
}

/** Value of a tag for this data: the value if non-blank, else the fallback, else ''. */
export function tagValue(part: Extract<TemplatePart, { kind: 'tag' }>, data: MergeData): string {
  const v = data[part.name];
  return v != null && v.trim() !== '' ? v : (part.fallback ?? '');
}

/** Substitutes tags (single pass). Text parts and values are returned as plain text; the caller escapes for HTML. */
export function substitute(parts: TemplatePart[], data: MergeData): string {
  return parts.map((p) => (p.kind === 'text' ? p.value : tagValue(p, data))).join('');
}

/** Tag names used in `input` (valid tags only). */
export function tagsIn(input: string): MergeTagName[] {
  return parseTemplate(input).parts.flatMap((p) => (p.kind === 'tag' ? [p.name] : []));
}
