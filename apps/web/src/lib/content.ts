'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { parseTemplateV2 } from '@workeasy/content';
import {
  type EmailBlock,
  type EmailBlockV3Draft,
  type EmailContentDraft,
  type EmailContentV2Draft,
  type EmailContentV3Draft,
  type EmailLeafBlockV3Draft,
  MERGE_TAG_NAMES,
  type MergeTagName,
  type SnippetListItem,
  type TemplateListItem,
  type TemplateVersionListItem,
  type TemplateView,
} from '@workeasy/shared';
import { http } from './api';
import { useWorkspaceApi } from './audience';

/**
 * Email content client (docs/contracts/phase-6-content-amendment.md). Rendering uses @workeasy/content — the same
 * pure function the API uses — so the live preview is what recipients get. Templates are server data.
 */
export const templateKeys = {
  all: (ws: string) => ['templates', ws] as const,
  list: (ws: string, q: string, category = '') => ['templates', ws, 'list', q, category] as const,
  one: (ws: string, id: string) => ['templates', ws, 'one', id] as const,
  categories: (ws: string) => ['templates', ws, 'categories'] as const,
  versions: (ws: string, id: string) => ['templates', ws, 'versions', id] as const,
};

type Page<T> = { data: T[]; nextCursor: string | null };

export function useTemplateList(q = '', enabled = true, category = '') {
  const { workspaceId, path } = useWorkspaceApi();
  return useInfiniteQuery({
    queryKey: templateKeys.list(workspaceId!, q, category),
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: '25' });
      if (q) params.set('q', q);
      if (category) params.set('category', category);
      if (pageParam) params.set('cursor', pageParam);
      return http.get<Page<TemplateListItem>>(path(`/templates?${params.toString()}`), signal);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!workspaceId && enabled,
  });
}

/** Distinct categories of live templates (7.1). */
export function useTemplateCategories() {
  const { workspaceId, path } = useWorkspaceApi();
  return useQuery({
    queryKey: templateKeys.categories(workspaceId!),
    queryFn: ({ signal }) => http.get<{ data: string[] }>(path('/template-categories'), signal),
    enabled: !!workspaceId,
  });
}

/** Version history of one template, newest first (7.1). */
export function useTemplateVersions(id: string | null) {
  const { workspaceId, path } = useWorkspaceApi();
  return useInfiniteQuery({
    queryKey: templateKeys.versions(workspaceId!, id ?? ''),
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      http.get<Page<TemplateVersionListItem>>(path(`/templates/${encodeURIComponent(id!)}/versions?limit=10${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`), signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!workspaceId && !!id,
  });
}

export function useTemplate(id: string | null) {
  const { workspaceId, path } = useWorkspaceApi();
  return useQuery({
    queryKey: templateKeys.one(workspaceId!, id ?? ''),
    queryFn: ({ signal }) => http.get<TemplateView>(path(`/templates/${encodeURIComponent(id!)}`), signal),
    enabled: !!workspaceId && !!id,
    retry: false,
  });
}

/** Human names of the merge fields (the closed allowlist of merge_tags_v1). */
export const MERGE_TAG_LABEL: Record<MergeTagName, string> = {
  'contact.first_name': 'First name',
  'contact.last_name': 'Last name',
  'contact.company': 'Company',
  'contact.email': 'Email address',
};

export const BLOCK_LABEL: Record<EmailBlockV3Draft['type'], string> = {
  heading: 'Heading',
  paragraph: 'Text',
  button: 'Button',
  image: 'Image',
  divider: 'Divider',
  spacer: 'Space',
  html: 'HTML',
  conditional: 'Conditional section',
};

/** A readable name for any merge field (custom fields show their key; the page has no label for them here). */
export function mergeFieldLabel(name: string): string {
  if (name in MERGE_TAG_LABEL) return MERGE_TAG_LABEL[name as MergeTagName];
  if (name in MERGE_FIELD_V2_LABEL) return MERGE_FIELD_V2_LABEL[name]!;
  return name.startsWith('contact.custom.') ? `Custom field “${name.slice('contact.custom.'.length)}”` : name;
}

/** merge_tags_v2 fixed names beyond v1 (Phase 7 §C, C13). */
export const MERGE_FIELD_V2_LABEL: Record<string, string> = {
  'workspace.name': 'Workspace name',
  'organization.name': 'Organization name',
};

export type DesignedContent = EmailContentV2Draft | EmailContentV3Draft;
export type AnyBlock = EmailBlockV3Draft;
export type LeafBlock = EmailLeafBlockV3Draft;

/** A short id unique within the message (block ids: /^[a-z0-9]{1,16}$/). */
export function newBlockId(existing: readonly { id: string }[]): string {
  const taken = new Set(existing.map((b) => b.id));
  for (;;) {
    const id = Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, '') || 'b';
    if (!taken.has(id)) return id;
  }
}

export function newBlock(type: EmailBlockV3Draft['type'], existing: readonly { id: string }[]): EmailBlockV3Draft {
  const id = newBlockId(existing);
  switch (type) {
    case 'html':
      return { id, type, html: '' };
    case 'conditional':
      return { id, type, when: { match: 'all', rules: [{ field: 'contact.first_name', op: 'is_set' }] }, then: [], else: [] };
    case 'heading':
      return { id, type, level: 2, runs: [] };
    case 'paragraph':
      return { id, type, runs: [] };
    case 'button':
      return { id, type, label: '', href: 'https://' };
    case 'image':
      return { id, type, src: 'https://', alt: '' };
    case 'divider':
      return { id, type };
    case 'spacer':
      return { id, type, height: 24 };
  }
}

/** A designed (v2) email from a plain-text (v1) one: one text block per paragraph. Nothing is lost. */
export function upgradeToBlocks(c: EmailContentDraft): EmailContentV2Draft {
  const paragraphs = c.body.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const blocks: EmailContentV2Draft['body']['blocks'] = [];
  for (const p of paragraphs) blocks.push({ id: newBlockId(blocks), type: 'paragraph', runs: [{ text: p }] });
  return { schema: 'email.content.v2', subject: c.subject, preheader: c.preheader, body: { format: 'blocks', blocks } };
}

export const emptyDesignedEmail = (): EmailContentV2Draft => ({ schema: 'email.content.v2', subject: '', preheader: '', body: { format: 'blocks', blocks: [] } });

/** Saved blocks of the workspace (Phase 7 §S), most recently updated first. */
export function useSnippets(enabled = true) {
  const { workspaceId, path } = useWorkspaceApi();
  return useQuery({
    queryKey: ['snippets', workspaceId] as const,
    queryFn: ({ signal }) => http.get<{ data: SnippetListItem[]; nextCursor: string | null }>(path('/snippets?limit=100'), signal),
    enabled: !!workspaceId && enabled,
  });
}

/** Copies blocks for insertion: every id (branches included) replaced by one unique in the target message. */
export function copyWithFreshIds(blocks: readonly AnyBlock[], existing: readonly { id: string }[]): AnyBlock[] {
  const taken = [...existing];
  const fresh = () => {
    const id = newBlockId(taken);
    taken.push({ id });
    return id;
  };
  return blocks.map((b) =>
    b.type === 'conditional'
      ? { ...structuredClone(b), id: fresh(), then: b.then.map((x) => ({ ...structuredClone(x), id: fresh() })), else: b.else.map((x) => ({ ...structuredClone(x), id: fresh() })) }
      : { ...structuredClone(b), id: fresh() },
  );
}

/** Every block id of a designed email, branches included (ids are unique across the whole message). */
export function allBlockIds(c: DesignedContent): { id: string }[] {
  const out: { id: string }[] = [];
  for (const b of c.body.blocks as AnyBlock[]) {
    out.push(b);
    if (b.type === 'conditional') out.push(...b.then, ...b.else);
  }
  return out;
}

/** v2 → v3 (Phase 7 §C): the same blocks under the v3 schema id — lossless, v2 blocks are v3 leaf blocks. */
export const upgradeToV3 = (c: EmailContentV2Draft): EmailContentV3Draft => ({ ...c, schema: 'email.content.v3' }) as EmailContentV3Draft;

const V1_NAMES: ReadonlySet<string> = new Set(MERGE_TAG_NAMES);

/** True when a v2 email uses something only v3 supports (a merge_tags_v2 field such as a custom field). */
function usesV3Fields(c: EmailContentV2Draft): boolean {
  const texts = [c.subject, c.preheader];
  for (const b of c.body.blocks) {
    if (b.type === 'heading' || b.type === 'paragraph') texts.push(...b.runs.map((r) => r.text));
    if (b.type === 'button') texts.push(b.label);
  }
  return texts.some((t) => parseTemplateV2(t).parts.some((p) => p.kind === 'tag' && !V1_NAMES.has(p.name)));
}

/** Keeps a designed email on the lowest schema that can hold it: v2 is upgraded to v3 only when it needs v3. */
export function withSchemaFor<T extends EmailContentDraft | DesignedContent>(c: T): T | EmailContentV3Draft {
  return c.schema === 'email.content.v2' && usesV3Fields(c) ? upgradeToV3(c) : c;
}

/**
 * Element id of the control a finding's JSON pointer is about. Blocks are addressed by their index in the SAVED
 * content (findings describe the saved draft): "/messages/0/content/body/blocks/3/runs/0/text" → "campaign-block-3-text".
 */
export function blockFieldId(index: number | string, field: 'text' | 'label' | 'href' | 'src' | 'alt' | 'html' | 'when'): string {
  return `campaign-block-${index}-${field}`;
}

/**
 * Nested blocks (v3 conditional branches) are addressed by their path: "/…/blocks/2/then/1/href" →
 * "campaign-block-2-then-1-href"; a rule of a condition → the condition's "when" control.
 */
export function contentFieldId(pointer: string): string | undefined {
  const m = /^\/messages\/0\/content\/body\/blocks\/(\d+(?:\/(?:then|else)\/\d+)?)(?:\/runs\/\d+)?\/(text|label|href|src|alt|html)$/.exec(pointer);
  if (m) return blockFieldId(m[1]!.replace(/\//g, '-'), m[2] as 'text');
  const w = /^\/messages\/0\/content\/body\/blocks\/(\d+)\/when(?:\/.*)?$/.exec(pointer);
  if (w) return blockFieldId(Number(w[1]), 'when');
  if (pointer === '/messages/0/content/body') return 'campaign-blocks';
  return undefined;
}
