import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { SlotCell } from '../api';
import { cx, fmtRange, inr } from '../lib';

/** Display status: a free slot that overlaps a booking is shown as "Overlaps", not Free. */
export type Status = 'free' | 'overlap' | 'partial' | 'full';
export type SlotFilter = 'all' | Status;
export const statusOf = (c: SlotCell): Status => (c.state === 'free' && c.overlaps?.length ? 'overlap' : c.state);
export type SlotRow = { key: string; groundId: string; date: string; cell: SlotCell };
/** title toggles the group when collapsible; actions sit on the right of the header. */
export type SlotGroup = { key: string; title: ReactNode; actions?: ReactNode; rows: SlotRow[]; emptyNote?: ReactNode };

const STATE: Record<Status, { label: string; pill: string; dot: string }> = {
  free: { label: 'Free', pill: 'bg-free-bg text-free', dot: 'bg-free' },
  overlap: { label: 'Overlaps', pill: 'bg-white text-partial ring-1 ring-inset ring-partial/40', dot: 'bg-partial/50' },
  partial: { label: 'Needs a team', pill: 'bg-partial-bg text-partial', dot: 'bg-partial' },
  full: { label: 'Booked', pill: 'bg-full-bg text-full', dot: 'bg-full' },
};

/** What's in a slot, in one line: "Lions vs Tigers", "Rana · promoter", "Acme Day (event)". */
export function bookingText(c: SlotCell): string {
  const b = c.booking;
  if (!b && c.overlaps?.length) return `Overlaps ${c.overlaps.map((o) => `${fmtRange(o.startTime, o.endTime)} ${o.label}`).join(', ')}`;
  if (!b) return c.defaultPrice != null ? `${inr(c.defaultPrice)} per team` : '';
  if (b.kind === 'event') return `${b.title || b.teams.join(', ') || 'Event'}${b.bookedBy === 'promoter' ? ' · promoter' : ''}`;
  if (b.bookedBy === 'promoter') return `${b.teams[0] ?? '?'} · promoter`;
  if (!b.teams.length) return 'No teams yet';
  return b.teams.length === 1 ? `${b.teams[0]} vs ?` : b.teams.join(' vs ');
}

/** All · Free · Needs a team · Booked, with counts. */
export function StatusFilter({ value, onChange, rows }: { value: SlotFilter; onChange: (f: SlotFilter) => void; rows: SlotRow[] }) {
  const count = (s: Status) => rows.filter((r) => statusOf(r.cell) === s).length;
  const opts: { v: SlotFilter; label: string; n: number; dot?: string }[] = [
    { v: 'all', label: 'All', n: rows.length },
    ...(['free', 'partial', 'full', 'overlap'] as const)
      .filter((s) => s !== 'overlap' || count(s) > 0 || value === 'overlap')
      .map((s) => ({ v: s as SlotFilter, label: STATE[s].label, n: count(s), dot: STATE[s].dot })),
  ];
  return (
    <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
      {opts.map((o) => (
        <button key={o.v} type="button" onClick={() => onChange(o.v)}
          className={cx('flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-semibold',
            value === o.v ? 'border-pitch bg-pitch text-white' : 'border-line bg-white text-ink')}>
          {o.dot && <span className={cx('h-2 w-2 rounded-full', o.dot, value === o.v && 'ring-2 ring-white/60')} />}
          {o.label}
          <span className={cx('tabular', value === o.v ? 'text-white/75' : 'text-muted')}>{o.n}</span>
        </button>
      ))}
    </div>
  );
}

const grid = 'grid grid-cols-[5.5rem_minmax(0,1fr)_auto] sm:grid-cols-[7rem_7.5rem_minmax(0,1fr)_7rem_5.5rem] items-center gap-x-3';

/** Grouped table of slots. Free → new booking pre-filled; booked → open the booking. */
/** Stable id of a row for inline expansion (survives the slot changing from free to booked). */
export const rowId = (r: SlotRow) => `${r.groundId}|${r.date}|${r.cell.slotTemplateId ?? r.cell.key}`;

export function SlotTable({ groups, filter, open, onToggle, expanded, onRowClick, renderExpanded }: {
  groups: SlotGroup[]; filter: SlotFilter;
  /** When given, groups are accordions: only keys in `open` are expanded. */
  open?: Set<string>; onToggle?: (key: string) => void;
  /** When given, tapping a row toggles inline content under it instead of opening a page. */
  expanded?: string | null; onRowClick?: (r: SlotRow) => void; renderExpanded?: (r: SlotRow) => ReactNode;
}) {
  const shown = groups.map((g) => ({ ...g, rows: filter === 'all' ? g.rows : g.rows.filter((r) => statusOf(r.cell) === filter) }));
  const any = shown.some((g) => g.rows.length);
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-card">
      <div className={cx(grid, 'hidden border-b border-line bg-paper px-4 py-2 text-[11px] font-bold uppercase tracking-wide text-muted sm:grid')}>
        <span>Time</span><span>Slot</span><span>Booking</span><span>Status</span><span className="text-right">Due</span>
      </div>
      {!any && <p className="px-4 py-8 text-center text-sm text-muted">{filter === 'all' ? 'No slots' : `No “${STATE[filter].label.toLowerCase()}” slots`}</p>}
      {shown.map((g) => (filter !== 'all' && !g.rows.length) ? null : (
        <section key={g.key}>
          <div className="flex items-center gap-3 border-y border-line bg-paper/80 px-4 py-2">
            {onToggle ? (
              <button type="button" onClick={() => onToggle(g.key)} aria-expanded={open?.has(g.key)} className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                  className={cx('shrink-0 text-muted transition-transform', open?.has(g.key) && 'rotate-90')}><path d="M9 18l6-6-6-6" /></svg>
                <span className="min-w-0 truncate">{g.title}</span>
                <Counts rows={g.rows} />
              </button>
            ) : <div className="min-w-0 flex-1">{g.title}</div>}
            {g.actions}
          </div>
          {onToggle && !open?.has(g.key) ? null : !g.rows.length ? (
            <div className="px-4 py-3 text-sm text-muted">{g.emptyNote ?? 'No slots'}</div>
          ) : g.rows.map((r) => {
            const isOpen = !!onRowClick && expanded === rowId(r);
            return (
              <div key={r.key} className={cx(isOpen && 'ring-2 ring-inset ring-pitch/25')}>
                <Row r={r} onClick={onRowClick} active={isOpen} />
                {isOpen && renderExpanded?.(r)}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

function Row({ r, onClick, active }: { r: SlotRow; onClick?: (r: SlotRow) => void; active?: boolean }) {
  const c = r.cell;
  const b = c.booking;
  const status = statusOf(c);
  const st = STATE[status];
  const to = b ? `/bookings/${b.id}` : `/bookings/new?groundId=${r.groundId}&date=${r.date}${c.slotTemplateId ? `&slot=${c.slotTemplateId}` : ''}`;
  const text = bookingText(c);
  return (
    <Wrap to={to} onClick={onClick && (() => onClick(r))} className={cx(grid, 'w-full border-t border-line/70 px-4 py-2.5 text-left active:bg-paper hover:bg-paper/60', active && 'bg-pitch/[0.04]')}>
      <span className="text-sm font-bold tabular">{fmtRange(c.startTime, c.endTime)}</span>
      <span className="hidden truncate text-sm text-muted sm:block">{c.name ?? 'Custom'}</span>
      <span className="min-w-0">
        <span className={cx('block truncate text-sm', b ? 'font-semibold' : status === 'overlap' ? 'text-partial' : 'text-muted')}>
          {status === 'overlap' && '⚠ '}{text || <span className="text-muted">—</span>}
        </span>
        <span className="block truncate text-xs text-muted sm:hidden">{c.name ?? 'Custom'}</span>
      </span>
      <span className="justify-self-end sm:justify-self-start">
        <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold', st.pill)}>
          <span className={cx('h-1.5 w-1.5 rounded-full', st.dot)} />{st.label}
        </span>
      </span>
      <span className={cx('hidden text-right text-sm tabular sm:block', b && b.balance > 0 ? 'font-semibold text-full' : 'text-muted')}>
        {b ? (b.balance > 0 ? inr(b.balance) : '✓') : ''}
      </span>
    </Wrap>
  );
}

/** "3 free · 1 needs a team · 2 booked" for a collapsed ground. */
function Counts({ rows }: { rows: SlotRow[] }) {
  const n = (st: Status) => rows.filter((r) => statusOf(r.cell) === st).length;
  const parts = (['free', 'partial', 'full', 'overlap'] as const).map((st) => [st, n(st)] as const).filter(([, c]) => c > 0);
  if (!parts.length) return <span className="ml-auto shrink-0 text-xs text-muted">No slots</span>;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2.5 text-xs font-semibold tabular">
      {parts.map(([st, c]) => (
        <span key={st} className="flex items-center gap-1" title={STATE[st].label}>
          <span className={cx('h-2 w-2 rounded-full', STATE[st].dot)} />{c}<span className="hidden font-medium text-muted sm:inline">{STATE[st].label.toLowerCase()}</span>
        </span>
      ))}
    </span>
  );
}

/** A row is a link to the booking page, or a button when the table expands rows inline. */
function Wrap({ to, onClick, className, children }: { to: string; onClick?: () => void; className: string; children: ReactNode }) {
  return onClick
    ? <button type="button" onClick={onClick} className={className}>{children}</button>
    : <Link to={to} className={className}>{children}</Link>;
}
