'use client';

import { AlertCircle, CheckCircle2, Info, Loader2, TriangleAlert, X } from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  createContext,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { cx, initials } from '@/lib/format';

// ─── Button ─────────────────────────────────────────────────────────────────────────────────────────────────

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-brand-700 disabled:opacity-60 dark:text-zinc-950',
  secondary: 'bg-surface text-ink border border-line hover:bg-surface-muted disabled:opacity-60',
  ghost: 'text-ink-muted hover:bg-surface-muted hover:text-ink disabled:opacity-60',
  danger: 'bg-danger text-white hover:opacity-90 disabled:opacity-60 dark:text-zinc-950',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, disabled, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-control font-medium transition-colors disabled:cursor-not-allowed',
        size === 'sm' ? 'h-8 px-3 text-sm' : 'h-10 px-4 text-sm',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

// ─── Form fields ────────────────────────────────────────────────────────────────────────────────────────────

const control =
  'w-full rounded-control border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:bg-surface-muted aria-invalid:border-danger';

interface FieldProps {
  label: string;
  hint?: ReactNode;
  errors?: string[];
  children: (props: { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string }) => ReactNode;
}

/** Label + control + hint + errors, wired for screen readers (aria-describedby / aria-invalid). */
export function Field({ label, hint, errors, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = errors?.length ? `${id}-err` : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children({
        id,
        'aria-invalid': errors?.length ? true : undefined,
        'aria-describedby': [hintId, errId].filter(Boolean).join(' ') || undefined,
      })}
      {hint && (
        <p id={hintId} className="text-xs text-ink-muted">
          {hint}
        </p>
      )}
      {errId && (
        <ul id={errId} className="space-y-0.5 text-xs text-danger" role="alert">
          {errors!.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(control, 'h-10', className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(control, 'h-10 pr-8', className)} {...rest}>
      {children}
    </select>
  );
}

// ─── Feedback ───────────────────────────────────────────────────────────────────────────────────────────────

const ALERT = {
  info: { cls: 'bg-accent-soft text-ink', Icon: Info },
  success: { cls: 'bg-success-soft text-ink', Icon: CheckCircle2 },
  warning: { cls: 'bg-warning-soft text-ink', Icon: TriangleAlert },
  danger: { cls: 'bg-danger-soft text-ink', Icon: AlertCircle },
};

export function Alert({ tone = 'info', title, children }: { tone?: keyof typeof ALERT; title?: string; children?: ReactNode }) {
  const { cls, Icon } = ALERT[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('flex gap-3 rounded-control px-4 py-3 text-sm', cls)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="space-y-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="text-ink-muted">{children}</div>}
      </div>
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-ink-muted">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}…
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; children: ReactNode }) {
  const cls = {
    neutral: 'bg-surface-muted text-ink-muted',
    accent: 'bg-accent-soft text-accent',
    success: 'bg-success-soft text-success',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger',
  }[tone];
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', cls)}>{children}</span>;
}

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent',
        size === 'sm' ? 'size-7 text-xs' : 'size-9 text-sm',
      )}
    >
      {initials(name)}
    </span>
  );
}

// ─── Layout ─────────────────────────────────────────────────────────────────────────────────────────────────

export function Card({ title, description, actions, children, className }: { title?: string; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-card border border-line bg-surface', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            {title && <h2 className="text-base font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-ink-muted">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-ink-muted">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-card border border-dashed border-line px-6 py-12 text-center">
      {icon && <div className="mb-3 text-ink-faint">{icon}</div>}
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {children && <p className="mt-1 max-w-sm text-sm text-ink-muted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Table({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full min-w-[560px] text-left text-sm">
        {children}
      </table>
    </div>
  );
}
export const Th = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <th scope="col" className={cx('border-b border-line px-3 py-2 text-xs font-medium uppercase tracking-wide text-ink-faint', className)}>
    {children}
  </th>
);
export const Td = ({ children, className, title }: { children?: ReactNode; className?: string; title?: string }) => (
  <td title={title} className={cx('border-b border-line px-3 py-3 align-middle text-ink', className)}>
    {children}
  </td>
);

// ─── Dialogs ────────────────────────────────────────────────────────────────────────────────────────────────

/** Native <dialog>: focus trapping, Escape-to-close and inert background come from the browser. */
export function Dialog({ open, onClose, title, description, children, footer }: { open: boolean; onClose: () => void; title: string; description?: ReactNode; children?: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close?.();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-card border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-black/40"
    >
      {open && (
        <div className="p-6">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h2 id={titleId} className="text-lg font-semibold">
                {title}
              </h2>
              {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
            </div>
            <button type="button" onClick={onClose} className="rounded-control p-1 text-ink-faint hover:bg-surface-muted hover:text-ink" aria-label="Close">
              <X className="size-4" />
            </button>
          </div>
          {children}
          {footer && <div className="mt-6 flex flex-wrap justify-end gap-2">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

/**
 * Confirmation for destructive actions. With `confirmText`, the user must type it (e.g. the organization name),
 * which prevents accidental deletion of important things.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  confirmText,
  busy,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  confirmText?: string;
  busy?: boolean;
  error?: string | null;
}) {
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);
  const ready = !confirmText || typed.trim() === confirmText;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={!ready} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-ink-muted">
        <div>{body}</div>
        {confirmText && (
          <Field label={`Type "${confirmText}" to confirm`}>
            {(p) => <Input {...p} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}
          </Field>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}

// ─── Toasts ─────────────────────────────────────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  tone: 'success' | 'danger' | 'info';
  message: string;
}
const ToastCtx = createContext<(tone: Toast['tone'], message: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto flex max-w-md items-center gap-2 rounded-control border border-line bg-surface px-4 py-3 text-sm shadow-lg">
            {t.tone === 'success' ? <CheckCircle2 className="size-4 text-success" aria-hidden /> : t.tone === 'danger' ? <AlertCircle className="size-4 text-danger" aria-hidden /> : <Info className="size-4 text-accent" aria-hidden />}
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
