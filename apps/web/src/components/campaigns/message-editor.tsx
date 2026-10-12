'use client';

import { markupToRuns, renderEmail, runsToMarkup, sanitizeHtml } from '@workeasy/content';
import {
  CONDITION_OPS,
  CONDITION_OPS_WITH_VALUE,
  type ConditionOp,
  type EmailContentDraft,
  type EmailContentV2Draft,
  type EmailContentV3Draft,
  type EmailRun,
  EMAIL_CONTENT_V2_LIMITS,
  EMAIL_CONTENT_V3_LIMITS,
  EXAMPLE_MERGE_DATA,
  EXAMPLE_MERGE_DATA_V2,
  MERGE_TAG_NAMES,
  type MergeTagName,
  SPACER_HEIGHTS,
} from '@workeasy/shared';
import { useQueryClient } from '@tanstack/react-query';
import type { SnippetView } from '@workeasy/shared';
import { ArrowDown, ArrowUp, BookmarkPlus, Monitor, Plus, Smartphone, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Dialog, Field, Input, Select, useToast } from '@/components/ui';
import { http } from '@/lib/api';
import { useCustomFields, useWorkspaceApi } from '@/lib/audience';
import {
  type AnyBlock,
  allBlockIds,
  BLOCK_LABEL,
  blockFieldId,
  copyWithFreshIds,
  type DesignedContent,
  type LeafBlock,
  MERGE_FIELD_V2_LABEL,
  MERGE_TAG_LABEL,
  newBlock,
  upgradeToBlocks,
  useSnippets,
  withSchemaFor,
} from '@/lib/content';
import { errorMessage } from '@/lib/forms';
import { cx } from '@/lib/format';
import { useCan, useOptionalAppContext } from '@/lib/session';
import { Counter, Textarea } from './common';

export type MessageContent = EmailContentDraft | EmailContentV2Draft | EmailContentV3Draft;

/** Placeholder link in previews (real unsubscribe links come with delivery). */
const PREVIEW_CTX = { unsubscribeUrl: '#unsubscribe-preview', reason: 'you subscribed to emails from this sender' };

/** A personal field offered by the "insert" menus and the condition editor. */
interface FieldOption {
  name: string;
  label: string;
  group: 'Contact' | 'Custom fields' | 'Sender';
}

const FieldsContext = createContext<FieldOption[]>([]);

/**
 * Fields a designed email can use: the contact basics, the workspace's ACTIVE custom fields (listed only for people
 * who may read contacts — anyone can still type a field; the server checks it) and the sender's names (merge_tags_v2).
 */
function useFieldOptions(): FieldOption[] {
  const can = useCan();
  const custom = useCustomFields(can('contacts.read'));
  return useMemo(() => {
    const out: FieldOption[] = MERGE_TAG_NAMES.map((n) => ({ name: n, label: MERGE_TAG_LABEL[n], group: 'Contact' as const }));
    for (const f of custom.data?.data ?? []) if (f.status === 'active') out.push({ name: `contact.custom.${f.key}`, label: f.label, group: 'Custom fields' });
    for (const [name, label] of Object.entries(MERGE_FIELD_V2_LABEL)) out.push({ name, label, group: 'Sender' });
    return out;
  }, [custom.data]);
}

/**
 * The campaign message (docs/contracts/phase-6-content-amendment.md; Phase 7 amendment §C). Plain-text (v1) messages
 * stay editable as text and can be turned into a designed email. A designed email is v2 until it uses something only
 * v3 can hold (an HTML block, a conditional section, a custom or sender field); it is then upgraded to v3 — losslessly,
 * since v2 blocks are v3 blocks. The live preview uses the same renderer as the server, in a sandboxed frame.
 */
export function MessageEditor({ value, disabled, onChange, errors }: { value: MessageContent; disabled: boolean; onChange: (v: MessageContent) => void; errors: Record<string, string[] | undefined> }) {
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const fields = useFieldOptions();
  const designed = value.schema !== 'email.content.v1';
  const emit = (next: MessageContent) => onChange(withSchemaFor(next));
  const set = (patch: Partial<MessageContent>) => emit({ ...value, ...patch } as MessageContent);

  return (
    <FieldsContext.Provider value={fields}>
      <div className="space-y-4">
        <div role="tablist" aria-label="Message view" className="flex gap-1 border-b border-line">
          {(['edit', 'preview'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`message-tab-${t}`}
              aria-selected={tab === t}
              aria-controls={`message-panel-${t}`}
              onClick={() => setTab(t)}
              className={cx('-mb-px border-b-2 px-3 py-2 text-sm font-medium', tab === t ? 'border-accent text-accent' : 'border-transparent text-ink-muted hover:text-ink')}
            >
              {t === 'edit' ? 'Edit' : 'Preview'}
            </button>
          ))}
        </div>

        <div role="tabpanel" id="message-panel-edit" aria-labelledby="message-tab-edit" hidden={tab !== 'edit'} className="space-y-4">
          <TextWithFields
            id="campaign-subject"
            label="Subject"
            value={value.subject}
            disabled={disabled}
            personalize={designed}
            max={EMAIL_CONTENT_V2_LIMITS.subject}
            hint={<Counter value={value.subject.length} soft={200} />}
            errors={errors['messages.0.content.subject']}
            onChange={(subject) => set({ subject })}
          />
          <TextWithFields
            id="campaign-preheader"
            label="Preview text (optional)"
            value={value.preheader}
            disabled={disabled}
            personalize={designed}
            max={EMAIL_CONTENT_V2_LIMITS.preheader}
            hint="Shown after the subject in most inboxes."
            onChange={(preheader) => set({ preheader })}
          />
          {value.schema === 'email.content.v1' ? (
            <PlainTextBody value={value} disabled={disabled} errors={errors} onChange={emit} />
          ) : (
            <div className="space-y-3" id="campaign-blocks" tabIndex={-1}>
              <h3 className="text-sm font-medium">Content</h3>
              <BlockList
                blocks={value.body.blocks as AnyBlock[]}
                allIds={allBlockIds(value)}
                idPrefix=""
                listLabel="Email blocks"
                max={EMAIL_CONTENT_V2_LIMITS.blocks}
                nested={false}
                disabled={disabled}
                emptyText="The email is empty. Add a heading, text or a button below."
                onChange={(blocks) => emit(asDesigned(value, blocks))}
              />
              {!disabled && <SavedBlocksBar allIds={allBlockIds(value)} onInsert={(blocks) => emit(asDesigned(value, [...(value.body.blocks as AnyBlock[]), ...blocks]))} />}
            </div>
          )}
        </div>

        <div role="tabpanel" id="message-panel-preview" aria-labelledby="message-tab-preview" hidden={tab !== 'preview'}>
          {tab === 'preview' && <LivePreview value={value} />}
        </div>
      </div>
    </FieldsContext.Provider>
  );
}

/** New blocks for a designed email; html/conditional blocks need v3 (the caller's `withSchemaFor` upgrades). */
function asDesigned(value: DesignedContent, blocks: AnyBlock[]): MessageContent {
  const needsV3 = blocks.some((b) => b.type === 'html' || b.type === 'conditional');
  return { ...value, schema: needsV3 ? 'email.content.v3' : value.schema, body: { format: 'blocks', blocks } } as MessageContent;
}

function PlainTextBody({ value, disabled, errors, onChange }: { value: EmailContentDraft; disabled: boolean; errors: Record<string, string[] | undefined>; onChange: (v: MessageContent) => void }) {
  return (
    <>
      <Field id="campaign-body" label="Message" hint={<Counter value={value.body.text.length} soft={100_000} />} errors={errors['messages.0.content.body.text']}>
        {(p) => <Textarea {...p} rows={10} value={value.body.text} disabled={disabled} maxLength={100_000} onChange={(e) => onChange({ ...value, body: { format: 'text', text: e.target.value } })} />}
      </Field>
      {!disabled && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-line p-3 text-sm text-ink-muted">
          <span>This is a plain-text email. A designed email adds headings, buttons, images and personal fields.</span>
          <Button size="sm" variant="secondary" icon={<Sparkles className="size-4" aria-hidden />} onClick={() => onChange(upgradeToBlocks(value))}>
            Switch to a designed email
          </Button>
        </div>
      )}
    </>
  );
}

const LEAF_TYPES = ['heading', 'paragraph', 'button', 'image', 'divider', 'spacer', 'html'] as const;
const TOP_TYPES = [...LEAF_TYPES, 'conditional'] as const;

/**
 * A list of blocks: the email body, or one branch of a conditional section (`nested`: leaf blocks only). `idPrefix`
 * addresses nested controls ("2-then-") so readiness findings can focus them.
 */
function BlockList({
  blocks,
  allIds,
  idPrefix,
  listLabel,
  max,
  nested,
  disabled,
  emptyText,
  onChange,
}: {
  blocks: AnyBlock[];
  allIds: { id: string }[];
  idPrefix: string;
  listLabel: string;
  max: number;
  nested: boolean;
  disabled: boolean;
  emptyText: string;
  onChange: (blocks: AnyBlock[]) => void;
}) {
  const update = (i: number, b: AnyBlock) => onChange(blocks.map((x, j) => (j === i ? b : x)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...blocks];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    onChange(next);
  };
  const full = blocks.length >= max || allIds.length >= EMAIL_CONTENT_V3_LIMITS.blocks;
  const where = nested ? listLabel.toLowerCase() : '';

  return (
    <div className="space-y-3">
      {blocks.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line p-4 text-sm text-ink-muted">{emptyText}</p>
      ) : (
        <ol aria-label={listLabel} className="space-y-3">
          {blocks.map((b, i) => {
            const n = `${where ? `${where} ` : ''}block ${i + 1}`;
            return (
              <li key={b.id} className={cx('rounded-lg border bg-surface p-3', b.type === 'conditional' ? 'border-accent/40' : 'border-line')}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                    {i + 1}. {BLOCK_LABEL[b.type]}
                  </span>
                  {!disabled && (
                    <div className="flex gap-1">
                      {!nested && <SaveAsSnippet block={b} label={n} />}
                      <IconButton label={`Move ${n} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                        <ArrowUp className="size-4" aria-hidden />
                      </IconButton>
                      <IconButton label={`Move ${n} down`} disabled={i === blocks.length - 1} onClick={() => move(i, 1)}>
                        <ArrowDown className="size-4" aria-hidden />
                      </IconButton>
                      <IconButton label={`Remove ${n}`} onClick={() => onChange(blocks.filter((_, j) => j !== i))}>
                        <Trash2 className="size-4" aria-hidden />
                      </IconButton>
                    </div>
                  )}
                </div>
                <BlockFields block={b} path={`${idPrefix}${i}`} allIds={allIds} disabled={disabled} onChange={(nb) => update(i, nb)} />
              </li>
            );
          })}
        </ol>
      )}
      {!disabled && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={nested ? `Add a block to ${listLabel.toLowerCase()}` : 'Add a block'}>
          {(nested ? LEAF_TYPES : TOP_TYPES).map((type) => (
            <Button key={type} size="sm" variant="secondary" disabled={full} onClick={() => onChange([...blocks, newBlock(type, allIds)])}>
              Add {BLOCK_LABEL[type].toLowerCase()}
            </Button>
          ))}
          {full && <span className="text-xs text-ink-muted">At most {nested ? `${max} blocks here` : `${EMAIL_CONTENT_V3_LIMITS.blocks} blocks`}.</span>}
        </div>
      )}
    </div>
  );
}

function BlockFields({ block: b, path, allIds, disabled, onChange }: { block: AnyBlock; path: string; allIds: { id: string }[]; disabled: boolean; onChange: (b: AnyBlock) => void }) {
  switch (b.type) {
    case 'heading':
      return (
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
          <Field label="Level">
            {(p) => (
              <Select {...p} value={b.level} disabled={disabled} onChange={(e) => onChange({ ...b, level: Number(e.target.value) as 1 | 2 | 3 })}>
                <option value={1}>Large</option>
                <option value={2}>Medium</option>
                <option value={3}>Small</option>
              </Select>
            )}
          </Field>
          <RunsField id={blockFieldId(path, 'text')} label="Heading text" runs={b.runs} single disabled={disabled} onChange={(runs) => onChange({ ...b, runs })} />
        </div>
      );
    case 'paragraph':
      return (
        <div className="space-y-3">
          <RunsField id={blockFieldId(path, 'text')} label="Text" runs={b.runs} disabled={disabled} onChange={(runs) => onChange({ ...b, runs })} />
          <AlignField value={b.align} disabled={disabled} onChange={(align) => onChange({ ...b, align })} />
        </div>
      );
    case 'button':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextWithFields id={blockFieldId(path, 'label')} label="Button label" value={b.label} disabled={disabled} personalize max={EMAIL_CONTENT_V2_LIMITS.buttonLabel} onChange={(label) => onChange({ ...b, label })} />
          <UrlField id={blockFieldId(path, 'href')} label="Link" value={b.href} disabled={disabled} onChange={(href) => onChange({ ...b, href })} />
          <AlignField value={b.align} disabled={disabled} onChange={(align) => onChange({ ...b, align })} />
        </div>
      );
    case 'image':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <UrlField id={blockFieldId(path, 'src')} label="Image address (https)" value={b.src} disabled={disabled} onChange={(src) => onChange({ ...b, src })} />
          <Field id={blockFieldId(path, 'alt')} label="Description (alt text)" hint="Read aloud by screen readers and shown when images are blocked.">
            {(p) => <Input {...p} value={b.alt} disabled={disabled} maxLength={EMAIL_CONTENT_V2_LIMITS.imageAlt} onChange={(e) => onChange({ ...b, alt: e.target.value })} />}
          </Field>
          <UrlField label="Link when clicked (optional)" value={b.href ?? ''} disabled={disabled} onChange={(href) => onChange(href ? { ...b, href } : withoutKey(b, 'href'))} />
          <Field label="Width in pixels (optional)" hint="16–600. Leave empty for full width.">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={16}
                max={600}
                value={b.width ?? ''}
                disabled={disabled}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  onChange(Number.isFinite(n) ? { ...b, width: Math.min(600, Math.max(16, n)) } : withoutKey(b, 'width'));
                }}
              />
            )}
          </Field>
        </div>
      );
    case 'spacer':
      return (
        <Field label="Height">
          {(p) => (
            <Select {...p} value={b.height} disabled={disabled} onChange={(e) => onChange({ ...b, height: Number(e.target.value) as (typeof SPACER_HEIGHTS)[number] })}>
              {SPACER_HEIGHTS.map((h) => (
                <option key={h} value={h}>
                  {h} px
                </option>
              ))}
            </Select>
          )}
        </Field>
      );
    case 'divider':
      return <p className="text-sm text-ink-muted">A thin line between sections.</p>;
    case 'html':
      return <HtmlFields block={b} path={path} disabled={disabled} onChange={onChange} />;
    case 'conditional':
      return <ConditionalFields block={b} path={path} allIds={allIds} disabled={disabled} onChange={onChange} />;
  }
}

/**
 * HTML block (Phase 7 §C, C15–C16): what the sanitizer would remove is shown as you type — the same pure function the
 * server applies — and nothing is removed silently: "Clean HTML" applies it on request.
 */
function HtmlFields({ block, path, disabled, onChange }: { block: Extract<AnyBlock, { type: 'html' }>; path: string; disabled: boolean; onChange: (b: AnyBlock) => void }) {
  const report = useMemo(() => sanitizeHtml(block.html), [block.html]);
  return (
    <div className="space-y-2">
      <Field
        id={blockFieldId(path, 'html')}
        label="HTML"
        hint={
          <>
            Text formatting, links, lists, tables and https images. Scripts, forms, embedded content and event handlers are not allowed.{' '}
            <Counter value={block.html.length} soft={EMAIL_CONTENT_V3_LIMITS.html} />
          </>
        }
      >
        {(p) => (
          <Textarea {...p} rows={8} value={block.html} disabled={disabled} maxLength={EMAIL_CONTENT_V3_LIMITS.html} spellCheck={false} className="font-mono text-xs" onChange={(e) => onChange({ ...block, html: e.target.value })} />
        )}
      </Field>
      {report.removed.length > 0 && (
        <Alert tone="warning" title="Some of this HTML cannot be sent safely">
          <p>These would be removed: {report.removed.slice(0, 8).join(', ')}{report.removed.length > 8 ? `, and ${report.removed.length - 8} more` : ''}.</p>
          {!disabled && (
            <div className="mt-2">
              <Button size="sm" variant="secondary" icon={<Wand2 className="size-4" aria-hidden />} onClick={() => onChange({ ...block, html: report.html })}>
                Clean HTML
              </Button>
            </div>
          )}
        </Alert>
      )}
    </div>
  );
}

const OP_LABEL: Record<ConditionOp, string> = {
  is_set: 'has a value',
  is_not_set: 'is empty',
  equals: 'is',
  not_equals: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
};

/** Conditional section (Phase 7 §C, C11–C12): rules over personal fields, then two branches of ordinary blocks. */
function ConditionalFields({ block, path, allIds, disabled, onChange }: { block: Extract<AnyBlock, { type: 'conditional' }>; path: string; allIds: { id: string }[]; disabled: boolean; onChange: (b: AnyBlock) => void }) {
  const fields = useContext(FieldsContext);
  const rules = block.when.rules;
  const setRules = (next: typeof rules) => onChange({ ...block, when: { ...block.when, rules: next } });
  const known = new Set(fields.map((f) => f.name));
  return (
    <div className="space-y-4">
      <fieldset id={blockFieldId(path, 'when')} tabIndex={-1} className="space-y-3 rounded-md border border-line p-3">
        <legend className="px-1 text-sm font-medium">Condition</legend>
        <Field label="Show the first branch when">
          {(p) => (
            <Select {...p} value={block.when.match} disabled={disabled} onChange={(e) => onChange({ ...block, when: { ...block.when, match: e.target.value === 'any' ? 'any' : 'all' } })}>
              <option value="all">all rules match</option>
              <option value="any">any rule matches</option>
            </Select>
          )}
        </Field>
        <ol aria-label="Rules" className="space-y-2">
          {rules.map((r, j) => (
            <li key={j} className="grid items-end gap-2 sm:grid-cols-[1fr_10rem_1fr_auto]">
              <Field label={`Rule ${j + 1} field`}>
                {(p) => (
                  <Select {...p} value={r.field} disabled={disabled} onChange={(e) => setRules(rules.map((x, k) => (k === j ? { ...x, field: e.target.value } : x)))}>
                    <option value="">Choose…</option>
                    {!known.has(r.field) && r.field && <option value={r.field}>{r.field}</option>}
                    {(['Contact', 'Custom fields', 'Sender'] as const).map((g) => {
                      const opts = fields.filter((f) => f.group === g);
                      return opts.length ? (
                        <optgroup key={g} label={g}>
                          {opts.map((f) => (
                            <option key={f.name} value={f.name}>
                              {f.label}
                            </option>
                          ))}
                        </optgroup>
                      ) : null;
                    })}
                  </Select>
                )}
              </Field>
              <Field label={`Rule ${j + 1} comparison`}>
                {(p) => (
                  <Select
                    {...p}
                    value={r.op}
                    disabled={disabled}
                    onChange={(e) => {
                      const op = e.target.value as ConditionOp;
                      setRules(rules.map((x, k) => (k === j ? (CONDITION_OPS_WITH_VALUE.has(op) ? { field: x.field, op, value: x.value ?? '' } : { field: x.field, op }) : x)));
                    }}
                  >
                    {CONDITION_OPS.map((op) => (
                      <option key={op} value={op}>
                        {OP_LABEL[op]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {CONDITION_OPS_WITH_VALUE.has(r.op) ? (
                <Field label={`Rule ${j + 1} value`}>
                  {(p) => <Input {...p} value={r.value ?? ''} disabled={disabled} maxLength={EMAIL_CONTENT_V3_LIMITS.ruleValue} onChange={(e) => setRules(rules.map((x, k) => (k === j ? { ...x, value: e.target.value } : x)))} />}
                </Field>
              ) : (
                <span aria-hidden />
              )}
              {!disabled && (
                <IconButton label={`Remove rule ${j + 1}`} onClick={() => setRules(rules.filter((_, k) => k !== j))}>
                  <Trash2 className="size-4" aria-hidden />
                </IconButton>
              )}
            </li>
          ))}
        </ol>
        {!disabled && rules.length < EMAIL_CONTENT_V3_LIMITS.rules && (
          <Button size="sm" variant="secondary" icon={<Plus className="size-4" aria-hidden />} onClick={() => setRules([...rules, { field: '', op: 'is_set' }])}>
            Add rule
          </Button>
        )}
        <p className="text-xs text-ink-muted">Comparisons ignore upper and lower case and surrounding spaces. An empty field matches “is empty” only.</p>
      </fieldset>
      <section aria-label={`If the condition matches (${BLOCK_LABEL.conditional.toLowerCase()} ${path})`} className="space-y-2">
        <h4 className="text-sm font-medium">If it matches</h4>
        <BlockList
          blocks={block.then}
          allIds={allIds}
          idPrefix={`${path}-then-`}
          listLabel="Matching branch"
          max={EMAIL_CONTENT_V3_LIMITS.branchBlocks}
          nested
          disabled={disabled}
          emptyText="Nothing is shown when the condition matches."
          onChange={(then) => onChange({ ...block, then: then as LeafBlock[] })}
        />
      </section>
      <section aria-label={`Otherwise (${BLOCK_LABEL.conditional.toLowerCase()} ${path})`} className="space-y-2">
        <h4 className="text-sm font-medium">Otherwise</h4>
        <BlockList
          blocks={block.else}
          allIds={allIds}
          idPrefix={`${path}-else-`}
          listLabel="Other branch"
          max={EMAIL_CONTENT_V3_LIMITS.branchBlocks}
          nested
          disabled={disabled}
          emptyText="Nothing is shown otherwise."
          onChange={(other) => onChange({ ...block, else: other as LeafBlock[] })}
        />
      </section>
    </div>
  );
}

/** "Insert saved block" (Phase 7 §S): copies the saved blocks with fresh ids into the message — no live link. */
function SavedBlocksBar({ allIds, onInsert }: { allIds: { id: string }[]; onInsert: (blocks: AnyBlock[]) => void }) {
  const can = useCan();
  const snippets = useSnippets(can('templates.read'));
  const { path } = useWorkspaceApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = snippets.data?.data ?? [];
  if (!can('templates.read') || !rows.length) return null;
  return (
    <div className="space-y-2">
      <div className="inline-flex items-center gap-2 text-sm">
        <label htmlFor="insert-saved-block" className="text-ink-muted">
          Insert saved block
        </label>
        <select
          id="insert-saved-block"
          className="rounded border border-line bg-surface px-2 py-1 text-sm"
          value=""
          disabled={busy}
          onChange={(e) => {
            const id = e.target.value;
            if (!id) return;
            setBusy(true);
            setError(null);
            http
              .get<SnippetView>(path(`/snippets/${encodeURIComponent(id)}`))
              .then((sn) => onInsert(copyWithFreshIds(sn.blocks as AnyBlock[], allIds)))
              .catch((err: unknown) => setError(errorMessage(err)))
              .finally(() => setBusy(false));
          }}
        >
          <option value="">Choose…</option>
          {rows.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
      {error && <Alert tone="danger">The saved block could not be inserted: {error}</Alert>}
    </div>
  );
}

/** "Save as reusable block": the block as a new saved block of the workspace (needs templates.manage). */
function SaveAsSnippet({ block, label }: { block: AnyBlock; label: string }) {
  const can = useCan();
  const { workspaceId, path } = useWorkspaceApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!can('templates.manage')) return null;
  const save = () => {
    setBusy(true);
    setError(null);
    http
      .post(path('/snippets'), { name: name.trim(), blocks: [block] })
      .then(async () => {
        await qc.invalidateQueries({ queryKey: ['snippets', workspaceId] });
        toast('success', 'Saved for reuse');
        setOpen(false);
        setName('');
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <IconButton label={`Save ${label} as a reusable block`} onClick={() => setOpen(true)}>
        <BookmarkPlus className="size-4" aria-hidden />
      </IconButton>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Save as a reusable block"
        description="It appears under “Insert saved block” in every designed email of this workspace. Inserting copies it; later changes do not reach emails that used it."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button loading={busy} disabled={!name.trim()} onClick={save}>
              Save block
            </Button>
          </>
        }
      >
        <Field label="Name" errors={error ? [error] : undefined}>
          {(p) => <Input {...p} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />}
        </Field>
      </Dialog>
    </>
  );
}

function withoutKey<T extends object, K extends keyof T>(o: T, k: K): T {
  const copy = { ...o };
  delete copy[k];
  return copy;
}

function AlignField({ value, disabled, onChange }: { value: 'left' | 'center' | undefined; disabled: boolean; onChange: (v: 'left' | 'center' | undefined) => void }) {
  return (
    <Field label="Alignment">
      {(p) => (
        <Select {...p} value={value ?? 'left'} disabled={disabled} onChange={(e) => onChange(e.target.value === 'center' ? 'center' : undefined)}>
          <option value="left">Left</option>
          <option value="center">Centered</option>
        </Select>
      )}
    </Field>
  );
}

function UrlField({ id, label, value, disabled, onChange }: { id?: string; label: string; value: string; disabled: boolean; onChange: (v: string) => void }) {
  return (
    <Field id={id} label={label}>
      {(p) => <Input {...p} type="url" inputMode="url" value={value} disabled={disabled} maxLength={EMAIL_CONTENT_V2_LIMITS.url} spellCheck={false} onChange={(e) => onChange(e.target.value.trim())} />}
    </Field>
  );
}

/**
 * Heading / paragraph text as light markup (**bold**, __italic__, [text](https://…)) over structured runs. The typed
 * text is kept locally so an unfinished marker never makes the cursor jump; runs are pushed up on every keystroke.
 */
function RunsField({ id, label, runs, single, disabled, onChange }: { id: string; label: string; runs: EmailRun[]; single?: boolean; disabled: boolean; onChange: (runs: EmailRun[]) => void }) {
  const [text, setText] = useState(() => runsToMarkup(runs));
  useEffect(() => {
    if (JSON.stringify(markupToRuns(text)) !== JSON.stringify(runs)) setText(runsToMarkup(runs));
    // Re-sync only when the runs change from outside (restore, template, reload) — not on our own edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs]);
  return (
    <TextWithFields
      id={id}
      label={label}
      value={text}
      disabled={disabled}
      personalize
      multiline={!single}
      max={EMAIL_CONTENT_V2_LIMITS.runText}
      hint="**bold**, __italic__, [link text](https://example.com)"
      onChange={(v) => {
        setText(v);
        onChange(markupToRuns(v));
      }}
    />
  );
}

/** A text control with an "insert personal field" menu that inserts at the cursor (designed emails only). */
function TextWithFields({
  id,
  label,
  value,
  disabled,
  personalize,
  multiline,
  max,
  hint,
  errors,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  personalize?: boolean;
  multiline?: boolean;
  max: number;
  hint?: ReactNode;
  errors?: string[];
  onChange: (v: string) => void;
}) {
  const fields = useContext(FieldsContext);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const insert = (name: string) => {
    const el = ref.current;
    const at = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? at;
    const tag = name === 'contact.first_name' ? `{{ ${name} | "there" }}` : `{{ ${name} }}`;
    onChange(value.slice(0, at) + tag + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + tag.length, at + tag.length);
    });
  };
  const options = fields.length ? fields : MERGE_TAG_NAMES.map((n) => ({ name: n, label: MERGE_TAG_LABEL[n as MergeTagName], group: 'Contact' as const }));
  return (
    <div className="space-y-1">
      <Field id={id} label={label} hint={hint} errors={errors}>
        {(p) =>
          multiline ? (
            <Textarea {...p} ref={ref} rows={4} value={value} disabled={disabled} maxLength={max} onChange={(e) => onChange(e.target.value)} />
          ) : (
            <Input {...p} ref={ref} value={value} disabled={disabled} maxLength={max} onChange={(e) => onChange(e.target.value)} />
          )
        }
      </Field>
      {personalize && !disabled && (
        <div className="inline-flex items-center gap-2 text-xs text-ink-muted">
          <label htmlFor={`${id}-insert`}>Insert personal field</label>
          {/* Explicit name: a select nested in its label would take the option texts into its accessible name. */}
          <select
            id={`${id}-insert`}
            aria-label={`Insert personal field into ${label}`}
            className="rounded border border-line bg-surface px-2 py-1 text-xs"
            value=""
            onChange={(e) => {
              if (e.target.value) insert(e.target.value);
            }}
          >
            <option value="">Choose…</option>
            {(['Contact', 'Custom fields', 'Sender'] as const).map((g) => {
              const opts = options.filter((f) => f.group === g);
              if (!opts.length) return null;
              const items = opts.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.label}
                </option>
              ));
              return g === 'Contact' ? items : (
                <optgroup key={g} label={g}>
                  {items}
                </optgroup>
              );
            })}
          </select>
        </div>
      )}
    </div>
  );
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="rounded p-1 text-ink-muted hover:bg-surface-muted hover:text-ink disabled:opacity-40">
      {children}
    </button>
  );
}

/**
 * Live preview with an example contact — rendered by the shared renderer in the browser, shown sandboxed. For v3, the
 * sender names are this workspace's, custom fields show "<label> (example)", and conditions use those example values.
 */
export function LivePreview({ value }: { value: MessageContent }) {
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const app = useOptionalAppContext();
  const fields = useContext(FieldsContext);
  const rendered = useMemo(() => {
    try {
      if (value.schema !== 'email.content.v3') return renderEmail(value, EXAMPLE_MERGE_DATA, PREVIEW_CTX);
      const data: Record<string, string | null> = {
        ...EXAMPLE_MERGE_DATA_V2,
        'workspace.name': app?.workspace?.name ?? EXAMPLE_MERGE_DATA_V2['workspace.name']!,
        'organization.name': app?.organization?.name ?? EXAMPLE_MERGE_DATA_V2['organization.name']!,
      };
      for (const f of fields) if (f.group === 'Custom fields') data[f.name] = `${f.label} (example)`;
      return renderEmail(value, data, PREVIEW_CTX);
    } catch {
      return null;
    }
  }, [value, app, fields]);
  if (!rendered) return <Alert tone="warning">The preview could not be built from this content.</Alert>;
  return <PreviewFrame subject={rendered.subject} preheader={rendered.preheader} html={rendered.html} text={rendered.text} device={device} onDevice={setDevice} note="Shown with an example contact (Alex Example)." />;
}

export function PreviewFrame({
  subject,
  preheader,
  html,
  text,
  device,
  onDevice,
  note,
}: {
  subject: string;
  preheader: string;
  html: string;
  text: string;
  device: 'desktop' | 'mobile';
  onDevice: (d: 'desktop' | 'mobile') => void;
  note?: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" data-testid="preview-subject">
            {subject || <span className="text-ink-muted">(no subject)</span>}
          </p>
          {preheader && <p className="truncate text-xs text-ink-muted">{preheader}</p>}
        </div>
        <div className="flex gap-1" role="group" aria-label="Preview width">
          <Button size="sm" variant={device === 'desktop' ? 'primary' : 'secondary'} aria-pressed={device === 'desktop'} icon={<Monitor className="size-4" aria-hidden />} onClick={() => onDevice('desktop')}>
            Desktop
          </Button>
          <Button size="sm" variant={device === 'mobile' ? 'primary' : 'secondary'} aria-pressed={device === 'mobile'} icon={<Smartphone className="size-4" aria-hidden />} onClick={() => onDevice('mobile')}>
            Mobile
          </Button>
        </div>
      </div>
      {note && <p className="text-xs text-ink-muted">{note}</p>}
      <div className="flex justify-center rounded-lg border border-line bg-surface-muted p-3">
        {/* sandbox="" : no scripts, no forms, no same-origin access — the renderer emits none, and the frame enforces it. */}
        <iframe title="Email preview" sandbox="" srcDoc={html} className={cx('h-[32rem] rounded bg-white', device === 'mobile' ? 'w-[375px]' : 'w-full max-w-[680px]')} />
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-ink-muted">Plain-text version</summary>
        <pre className="mt-2 whitespace-pre-wrap rounded border border-line bg-surface p-3 text-xs">{text}</pre>
      </details>
    </div>
  );
}
