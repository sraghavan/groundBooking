import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Link, useNavigate } from 'react-router';
import { cx } from '../lib';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'whatsapp';
const variants: Record<Variant, string> = {
  primary: 'bg-pitch text-white active:bg-pitch-2 disabled:opacity-50',
  secondary: 'bg-white text-ink border border-line active:bg-paper disabled:opacity-50',
  ghost: 'text-pitch active:bg-pitch/5',
  danger: 'bg-white text-full border border-full/30 active:bg-full-bg',
  whatsapp: 'bg-[#1f9d55] text-white active:bg-[#178246]',
};

export function Button({ variant = 'primary', size = 'md', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return (
    <button
      {...p}
      className={cx('inline-flex items-center justify-center gap-1.5 rounded-xl font-semibold transition-colors',
        size === 'sm' ? 'h-9 px-3 text-sm' : 'h-12 px-4 text-[15px]', variants[variant], className)}
    />
  );
}

export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-muted">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-full">{error}</span>}
    </label>
  );
}

const inputCls = 'w-full h-12 rounded-xl border border-line bg-white px-3 text-ink outline-none focus:border-pitch focus:ring-2 focus:ring-pitch/15 disabled:bg-paper';
export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(inputCls, className)} />;
export const Select = ({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(inputCls, 'appearance-none bg-[length:16px] bg-[right_12px_center] bg-no-repeat pr-9', className)} style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='%236b7568'%3E%3Cpath d='M5.3 7.3a1 1 0 0 1 1.4 0L10 10.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4z'/%3E%3C/svg%3E\")" }} />;
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(inputCls, 'h-auto min-h-20 py-2', className)} />;

/** Rupee input that keeps a number. */
export function MoneyInput({ value, onChange, className, ...p }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: number | ''; onChange: (v: number | '') => void }) {
  return (
    <div className={cx('relative', className)}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">₹</span>
      <Input {...p} inputMode="numeric" className="pl-7 tabular" value={value}
        onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); onChange(d === '' ? '' : Number(d)); }} />
    </div>
  );
}

export const Card = ({ className, children, ...p }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) =>
  <div {...p} className={cx('rounded-2xl border border-line bg-card', className)}>{children}</div>;

export function Segmented<T extends string>({ value, options, onChange, className }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cx('flex rounded-xl bg-line/60 p-1', className)}>
      {options.map((o) => (
        <button type="button" key={o.value} onClick={() => onChange(o.value)}
          className={cx('h-9 flex-1 rounded-lg px-2 text-sm font-semibold transition-colors', o.value === value ? 'bg-white text-pitch shadow-sm' : 'text-muted')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({ active, children, onClick }: { active?: boolean; children: ReactNode; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={cx('h-8 shrink-0 rounded-full border px-3 text-sm font-semibold', active ? 'border-pitch bg-pitch text-white' : 'border-line bg-white text-ink')}>
      {children}
    </button>
  );
}

export function PageHeader({ title, back, action, sub }: { title: string; back?: string | true; action?: ReactNode; sub?: ReactNode }) {
  const nav = useNavigate();
  return (
    <header className="pt-safe sticky top-0 z-20 border-b border-line bg-paper/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-2xl items-center gap-2 px-4">
        {back && (
          <button aria-label="Back" onClick={() => (back === true ? nav(-1) : nav(back))} className="-ml-2 grid h-10 w-10 place-items-center rounded-full active:bg-line/60">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
        )}
        <h1 className="flex-1 truncate font-display text-[22px] font-semibold text-pitch">{title}</h1>
        {action}
      </div>
      {sub && <div className="mx-auto max-w-2xl px-4 pb-3">{sub}</div>}
    </header>
  );
}

export const Page = ({ children, className }: { children: ReactNode; className?: string }) =>
  <main className={cx('mx-auto max-w-2xl px-4 pb-28 pt-4', className)}>{children}</main>;

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line px-6 py-10 text-center">
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-2 text-sm text-muted">{children}</div>}
    </div>
  );
}

export const Spinner = () => <div className="flex justify-center py-10"><div className="h-6 w-6 animate-spin rounded-full border-2 border-pitch border-t-transparent" /></div>;

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return <div role="alert" className="rounded-xl border border-full/30 bg-full-bg px-3 py-2 text-sm text-full">{error instanceof Error ? error.message : String(error)}</div>;
}

/** Bottom sheet on mobile, centred dialog on wider screens. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div className="pb-safe relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-paper sm:rounded-3xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-paper px-5 py-4">
          <h2 className="font-display text-lg font-semibold text-pitch">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-full active:bg-line/60">✕</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function ListLink({ to, title, sub, right }: { to: string; title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <Link to={to} className="flex items-center gap-3 px-4 py-3.5 active:bg-paper">
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">{title}</div>
        {sub && <div className="truncate text-sm text-muted">{sub}</div>}
      </div>
      {right}
      <span className="text-muted">›</span>
    </Link>
  );
}

export const StatusBadge = ({ status }: { status: string }) => {
  const map: Record<string, string> = {
    confirmed: 'bg-pitch/10 text-pitch', completed: 'bg-free-bg text-free', partial: 'bg-partial-bg text-partial', cancelled: 'bg-line text-muted line-through',
  };
  const label: Record<string, string> = { confirmed: 'Confirmed', completed: 'Completed', partial: 'Not completed', cancelled: 'Cancelled' };
  return <span className={cx('rounded-full px-2 py-0.5 text-xs font-semibold', map[status])}>{label[status] ?? status}</span>;
};

/** In-app "are you sure?" box (not a browser dialog). */
export function ConfirmSheet({ title, children, confirmLabel, onConfirm, onCancel }: {
  title: string; children: ReactNode; confirmLabel: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Sheet open onClose={onCancel} title={title}>
      <div className="space-y-4">
        <div className="text-sm">{children}</div>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="flex-1" onClick={onCancel}>No, go back</Button>
          <Button type="button" variant="danger" className="flex-1" onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </Sheet>
  );
}
