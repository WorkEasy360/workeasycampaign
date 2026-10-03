'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CUSTOM_FIELD_TYPES, createCustomFieldRequest, type CustomFieldType, type CustomFieldView } from '@workeasy/shared';
import { ArrowDown, ArrowUp, Lock, Plus } from 'lucide-react';
import { useState } from 'react';
import { AudiencePage } from '@/components/audience-shell';
import { Alert, Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, Td, Th, useToast } from '@/components/ui';
import { http } from '@/lib/api';
import { audienceKeys, useCustomFields, useWorkspaceApi } from '@/lib/audience';
import { errorMessage, useForm } from '@/lib/forms';
import { useCan } from '@/lib/session';

const TYPE_LABEL: Record<CustomFieldType, string> = {
  text: 'Text',
  long_text: 'Long text',
  number: 'Whole number',
  decimal: 'Decimal',
  boolean: 'Yes / no',
  date: 'Date',
  datetime: 'Date and time',
  single_select: 'Single choice',
  multi_select: 'Multiple choice',
  email: 'Email',
  phone: 'Phone',
  url: 'Web address',
};

const toKey = (label: string) =>
  label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+|_+$/g, '')
    .slice(0, 40);

function FieldsInner() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const { workspaceId, path } = useWorkspaceApi();
  const fields = useCustomFields();
  const [editing, setEditing] = useState<CustomFieldView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<CustomFieldView | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: audienceKeys.fields(workspaceId!) });
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: async () => {
      setDeleting(null);
      await refresh();
    },
    onError: (err) => toast('danger', errorMessage(err)),
  });
  const manage = can('custom_fields.manage');
  const rows = [...(fields.data?.data ?? [])].sort((a, b) => a.position - b.position);
  const move = (i: number, d: -1 | 1) => {
    const ids = rows.map((r) => r.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    act.mutate(() => http.put(path('/custom-fields/order'), { fieldIds: ids }));
  };

  return (
    <>
      <PageHeader
        title="Custom fields"
        description="Extra information you keep about contacts. Once a field holds data its key and type are locked, and it can only be archived."
        actions={manage && <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>New field</Button>}
      />
      {fields.isLoading ? (
        <Spinner />
      ) : fields.isError ? (
        <Alert tone="danger">{errorMessage(fields.error)}</Alert>
      ) : rows.length === 0 ? (
        <EmptyState title="No custom fields" action={manage && <Button onClick={() => setEditing('new')}>Add a field</Button>}>
          Add fields such as “City”, “Customer since” or “Interests”.
        </EmptyState>
      ) : (
        <Table label="Custom fields">
          <thead>
            <tr>
              {manage && (
                <Th>
                  <span className="sr-only">Order</span>
                </Th>
              )}
              <Th>Label</Th>
              <Th>Key</Th>
              <Th>Type</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f, i) => (
              <tr key={f.id}>
                {manage && (
                  <Td className="whitespace-nowrap">
                    <button type="button" className="p-1 text-ink-faint hover:text-ink disabled:opacity-30" aria-label={`Move ${f.label} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp className="size-4" />
                    </button>
                    <button type="button" className="p-1 text-ink-faint hover:text-ink disabled:opacity-30" aria-label={`Move ${f.label} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown className="size-4" />
                    </button>
                  </Td>
                )}
                <Td>
                  <span className="font-medium">{f.label}</span> {f.required && <Badge tone="accent">Required</Badge>} {f.status === 'archived' && <Badge>Archived</Badge>}
                </Td>
                <Td>
                  <code className="text-xs">{f.key}</code> {f.keyLocked && <Lock className="inline size-3 text-ink-faint" aria-label="Key locked: field holds data" />}
                </Td>
                <Td>{TYPE_LABEL[f.type]}</Td>
                <Td className="whitespace-nowrap text-right">
                  {manage && (
                    <>
                      {f.status === 'active' && (
                        <Button size="sm" variant="ghost" onClick={() => setEditing(f)}>
                          Edit
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => act.mutate(() => http.post(path(`/custom-fields/${f.id}/${f.status === 'active' ? 'archive' : 'restore'}`)))}>
                        {f.status === 'active' ? 'Archive' : 'Restore'}
                      </Button>
                      {!f.keyLocked && (
                        <Button size="sm" variant="ghost" className="text-danger" onClick={() => setDeleting(f)}>
                          Delete
                        </Button>
                      )}
                    </>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <FieldDialog field={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && act.mutate(() => http.delete(path(`/custom-fields/${deleting.id}`)))}
        title={`Delete “${deleting?.label}”?`}
        body="This field has never held data, so it can be deleted outright."
        confirmLabel="Delete field"
        busy={act.isPending}
      />
    </>
  );
}

type Draft = { label: string; key: string; keyTouched: boolean; type: CustomFieldType; description: string; required: boolean; options: { key: string; label: string; archived: boolean }[]; maxLength: string; min: string; max: string };

function FieldDialog({ field, onClose, onSaved }: { field: CustomFieldView | 'new' | null; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const { path } = useWorkspaceApi();
  const toast = useToast();
  const form = useForm(createCustomFieldRequest);
  const existing = field && field !== 'new' ? field : null;
  const blank: Draft = { label: '', key: '', keyTouched: false, type: 'text', description: '', required: false, options: [], maxLength: '', min: '', max: '' };
  const [d, setD] = useState<Draft>(blank);
  const [newOption, setNewOption] = useState('');
  const [openFor, setOpenFor] = useState<unknown>(null);
  if (field !== openFor) {
    setOpenFor(field);
    setNewOption('');
    setD(
      existing
        ? {
            label: existing.label,
            key: existing.key,
            keyTouched: true,
            type: existing.type,
            description: existing.description,
            required: existing.required,
            options: existing.options,
            maxLength: existing.validation.maxLength?.toString() ?? '',
            min: existing.validation.min?.toString() ?? '',
            max: existing.validation.max?.toString() ?? '',
          }
        : blank,
    );
  }
  const locked = !!existing?.keyLocked;
  const isSelect = d.type === 'single_select' || d.type === 'multi_select';
  const isNumeric = d.type === 'number' || d.type === 'decimal';
  const isText = d.type === 'text' || d.type === 'long_text';
  const originalOptions = new Set(existing?.options.map((o) => o.key));

  function addOption() {
    const label = newOption.trim();
    const key = toKey(label);
    if (!label || !key || d.options.some((o) => o.key === key)) return;
    setD((x) => ({ ...x, options: [...x.options, { key, label, archived: false }] }));
    setNewOption('');
  }

  return (
    <Dialog
      open={!!field}
      onClose={onClose}
      title={existing ? `Edit “${existing.label}”` : 'New custom field'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={form.submitting}
            onClick={() => {
              const validation = {
                ...(isText && d.maxLength ? { maxLength: Number(d.maxLength) } : {}),
                ...(isNumeric && d.min !== '' ? { min: Number(d.min) } : {}),
                ...(isNumeric && d.max !== '' ? { max: Number(d.max) } : {}),
              };
              void form.submit(
                { key: d.key, label: d.label, type: d.type, description: d.description, required: d.required, options: isSelect ? d.options : [], validation },
                async (data) => {
                  if (existing) {
                    await http.patch(path(`/custom-fields/${existing.id}`), {
                      label: data.label,
                      description: data.description,
                      required: data.required,
                      options: data.options,
                      validation: data.validation,
                      ...(locked ? {} : { key: data.key, type: data.type }),
                      version: existing.version,
                    });
                  } else {
                    await http.post(path('/custom-fields'), data);
                  }
                  toast('success', existing ? 'Field saved' : 'Field created');
                  await onSaved();
                  onClose();
                },
              );
            }}
          >
            {existing ? 'Save' : 'Create field'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {form.formError && <Alert tone="danger">{form.formError}</Alert>}
        <Field label="Label" errors={form.fieldErrors.label}>
          {(p) => <Input {...p} value={d.label} onChange={(e) => setD((x) => ({ ...x, label: e.target.value, key: x.keyTouched ? x.key : toKey(e.target.value) }))} />}
        </Field>
        <Field label="Key" hint={locked ? 'Locked: contacts already hold data in this field.' : 'Lowercase letters, numbers and underscores. Used in imports and the API.'} errors={form.fieldErrors.key}>
          {(p) => <Input {...p} value={d.key} disabled={locked} onChange={(e) => setD((x) => ({ ...x, key: e.target.value, keyTouched: true }))} />}
        </Field>
        <Field label="Type" hint={locked ? 'Locked: contacts already hold data in this field.' : undefined} errors={form.fieldErrors.type}>
          {(p) => (
            <Select {...p} value={d.type} disabled={locked} onChange={(e) => setD((x) => ({ ...x, type: e.target.value as CustomFieldType }))}>
              {CUSTOM_FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {isSelect && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Choices</legend>
            {form.fieldErrors.options && <p className="text-xs text-danger">{form.fieldErrors.options.join(' ')}</p>}
            <ul className="space-y-1">
              {d.options.map((o, i) => (
                <li key={o.key} className="flex items-center gap-2 text-sm">
                  <span className={o.archived ? 'text-ink-faint line-through' : ''}>{o.label}</span>
                  <code className="text-xs text-ink-faint">{o.key}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() =>
                      setD((x) => ({
                        ...x,
                        options: originalOptions.has(o.key) ? x.options.map((y, j) => (j === i ? { ...y, archived: !y.archived } : y)) : x.options.filter((_, j) => j !== i),
                      }))
                    }
                  >
                    {originalOptions.has(o.key) ? (o.archived ? 'Restore' : 'Archive') : 'Remove'}
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Input
                aria-label="New choice"
                placeholder="Add a choice"
                value={newOption}
                onChange={(e) => setNewOption(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addOption();
                  }
                }}
              />
              <Button variant="secondary" onClick={addOption}>
                Add
              </Button>
            </div>
            <p className="text-xs text-ink-faint">Saved choices are archived rather than removed, so existing contact values stay meaningful.</p>
          </fieldset>
        )}
        {isText && (
          <Field label="Maximum length (optional)" errors={form.fieldErrors['validation.maxLength']}>
            {(p) => <Input {...p} type="number" min={1} value={d.maxLength} onChange={(e) => setD((x) => ({ ...x, maxLength: e.target.value }))} />}
          </Field>
        )}
        {isNumeric && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Minimum (optional)" errors={form.fieldErrors['validation.min']}>
              {(p) => <Input {...p} type="number" value={d.min} onChange={(e) => setD((x) => ({ ...x, min: e.target.value }))} />}
            </Field>
            <Field label="Maximum (optional)" errors={form.fieldErrors['validation.max'] ?? form.fieldErrors.validation}>
              {(p) => <Input {...p} type="number" value={d.max} onChange={(e) => setD((x) => ({ ...x, max: e.target.value }))} />}
            </Field>
          </div>
        )}
        <Field label="Description (optional)" errors={form.fieldErrors.description}>
          {(p) => <Input {...p} value={d.description} onChange={(e) => setD((x) => ({ ...x, description: e.target.value }))} />}
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={d.required} onChange={(e) => setD((x) => ({ ...x, required: e.target.checked }))} />
          Required when creating or editing a contact
        </label>
      </div>
    </Dialog>
  );
}

export default function CustomFieldsPage() {
  return (
    <AudiencePage>
      <FieldsInner />
    </AudiencePage>
  );
}
