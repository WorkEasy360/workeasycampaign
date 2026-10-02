import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CurrentContext } from '@workeasy/shared';
import { describe, expect, it, vi } from 'vitest';
import { ContextProvider, useCan } from '@/lib/session';
import { ConfirmDialog, Field, Input } from './ui';

describe('Field', () => {
  it('links the label, hint and errors to the control for assistive technology', () => {
    render(
      <Field label="Email" hint="We never share it" errors={['Enter a valid email address']}>
        {(p) => <Input {...p} />}
      </Field>,
    );
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/We never share it.*Enter a valid email address/);
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email address');
  });

  it('is not marked invalid without errors', () => {
    render(<Field label="Name">{(p) => <Input {...p} />}</Field>);
    expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid');
  });
});

describe('ConfirmDialog', () => {
  it('requires typing the exact name before a destructive action', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open onClose={() => undefined} onConfirm={onConfirm} title="Delete Acme?" body="Gone" confirmLabel="Delete organization" confirmText="Acme" />);
    const confirm = screen.getByRole('button', { name: 'Delete organization' });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Type "Acme" to confirm'), 'Acm');
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Type "Acme" to confirm'), 'e');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

describe('permission hints', () => {
  function Probe() {
    const can = useCan();
    return <p>{can('members.invite') ? 'can invite' : 'cannot invite'}</p>;
  }
  const ctx = (permissions: string[]): CurrentContext =>
    ({ user: { id: 'u', email: 'u@x', displayName: 'U', emailVerified: true }, organization: { id: 'o', name: 'O', slug: 'o' }, workspace: null, permissions }) as CurrentContext;

  it('reflects the permissions the API returned', () => {
    const { rerender } = render(
      <ContextProvider value={ctx(['members.invite'])}>
        <Probe />
      </ContextProvider>,
    );
    expect(screen.getByText('can invite')).toBeInTheDocument();
    rerender(
      <ContextProvider value={ctx(['members.read'])}>
        <Probe />
      </ContextProvider>,
    );
    expect(screen.getByText('cannot invite')).toBeInTheDocument();
  });
});
