'use client';

import type { CustomFieldView } from '@workeasy/shared';
import { Field, Input, Select } from './ui';

/** Renders the right control for a custom field type. Values are sent as typed; the API validates authoritatively. */
export function CustomFieldInput({
  field,
  value,
  onChange,
  errors,
  disabled,
}: {
  field: CustomFieldView;
  value: unknown;
  onChange: (v: unknown) => void;
  errors?: string[];
  disabled?: boolean;
}) {
  const label = `${field.label}${field.required ? ' *' : ''}`;
  const hint = field.status === 'archived' ? 'Archived field — read only' : field.description || undefined;
  const ro = disabled || field.status === 'archived';
  const active = field.options.filter((o) => !o.archived);

  if (field.type === 'boolean') {
    return (
      <Field label={label} hint={hint} errors={errors}>
        {(p) => (
          <Select {...p} disabled={ro} value={value === true ? 'true' : value === false ? 'false' : ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'true')}>
            <option value="">Not set</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </Select>
        )}
      </Field>
    );
  }
  if (field.type === 'single_select') {
    return (
      <Field label={label} hint={hint} errors={errors}>
        {(p) => (
          <Select {...p} disabled={ro} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || null)}>
            <option value="">Not set</option>
            {field.options.map((o) => (
              <option key={o.key} value={o.key} disabled={o.archived}>
                {o.label}
                {o.archived ? ' (archived)' : ''}
              </option>
            ))}
          </Select>
        )}
      </Field>
    );
  }
  if (field.type === 'multi_select') {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">{label}</legend>
        <div className="flex flex-wrap gap-3">
          {active.map((o) => (
            <label key={o.key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                disabled={ro}
                checked={selected.includes(o.key)}
                onChange={(e) => onChange(e.target.checked ? [...selected, o.key] : selected.filter((k) => k !== o.key))}
              />
              {o.label}
            </label>
          ))}
        </div>
        {errors?.length ? <p className="text-xs text-danger">{errors.join(' ')}</p> : null}
      </fieldset>
    );
  }
  const inputType =
    field.type === 'number' || field.type === 'decimal'
      ? 'number'
      : field.type === 'date'
        ? 'date'
        : field.type === 'email'
          ? 'email'
          : field.type === 'url'
            ? 'url'
            : field.type === 'phone'
              ? 'tel'
              : 'text';
  const str = value === null || value === undefined ? '' : field.type === 'datetime' ? String(value).slice(0, 16) : String(value);
  return (
    <Field label={label} hint={hint ?? (field.type === 'phone' ? 'Include the country code, e.g. +91…' : undefined)} errors={errors}>
      {(p) =>
        field.type === 'long_text' ? (
          <textarea {...p} disabled={ro} rows={3} className="w-full rounded-control border border-line bg-surface px-3 py-2 text-sm" value={str} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <Input
            {...p}
            disabled={ro}
            type={field.type === 'datetime' ? 'datetime-local' : inputType}
            step={field.type === 'decimal' ? 'any' : undefined}
            value={str}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '') return onChange(null);
              if (field.type === 'number' || field.type === 'decimal') return onChange(Number(v));
              if (field.type === 'datetime') return onChange(new Date(v).toISOString());
              onChange(v);
            }}
          />
        )
      }
    </Field>
  );
}
