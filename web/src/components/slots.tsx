import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import type { SlotCell, SlotState } from '../api';
import { addDays, cx, fmtDate, fmtDay, fmtRange, inr, todayISO } from '../lib';

const stateCls: Record<SlotState, string> = {
  free: 'border-free/25 bg-free-bg text-free',
  partial: 'border-partial/30 bg-partial-bg text-partial',
  full: 'border-full/25 bg-full-bg text-full',
};
const stateLabel: Record<SlotState, string> = { free: 'Free', partial: 'Needs a team', full: 'Booked' };

export function Legend() {
  return (
    <div className="flex gap-3 text-xs font-semibold text-muted">
      {(['free', 'partial', 'full'] as const).map((s) => (
        <span key={s} className="flex items-center gap-1.5">
          <span className={cx('h-2.5 w-2.5 rounded-full border', stateCls[s])} style={{ background: `var(--color-${s})` }} />
          {stateLabel[s]}
        </span>
      ))}
    </div>
  );
}

/** One slot tile. Free → new booking pre-filled from the slot; booked → open the booking. */
export function SlotTile({ cell, groundId, date, compact }: { cell: SlotCell; groundId: string; date: string; compact?: boolean }) {
  const to = cell.booking
    ? `/bookings/${cell.booking.id}`
    : `/bookings/new?groundId=${groundId}&date=${date}${cell.slotTemplateId ? `&slot=${cell.slotTemplateId}` : ''}`;
  const b = cell.booking;
  const teamLine = !b ? null
    : b.kind === 'promoter' ? `${b.teams[0] ?? 'Promoter'} · promoter`
    : b.kind === 'event' ? b.title || b.teams.join(', ') || 'Event'
    : b.teams.length ? b.teams.join(' vs ') : 'No teams yet';
  return (
    <Link to={to} className={cx('block rounded-xl border px-3 py-2 active:scale-[0.98] transition-transform', stateCls[cell.state])}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-bold tabular">{fmtRange(cell.startTime, cell.endTime)}</span>
        {!compact && cell.name && <span className="truncate text-[11px] font-semibold uppercase tracking-wide opacity-80">{cell.name}</span>}
      </div>
      <div className={cx('mt-0.5 truncate text-[13px]', b ? 'font-semibold text-ink' : 'font-medium')}>
        {b ? teamLine : cell.defaultPrice != null ? `Free · ${inr(cell.defaultPrice)}/team` : 'Free'}
        {b?.kind === 'match' && b.teams.length === 1 && <span className="font-medium text-partial"> · vs ?</span>}
      </div>
    </Link>
  );
}

/** Horizontally scrolling date picker. */
export function DateStrip({ value, onChange, days = 21 }: { value: string; onChange: (d: string) => void; days?: number }) {
  const today = todayISO();
  const start = addDays(value < today ? value : today, -1);
  const dates = Array.from({ length: days }, (_, i) => addDays(start, i));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('[data-active="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [value]);
  return (
    <div className="flex items-center gap-2">
      <div ref={ref} className="no-scrollbar -mx-4 flex flex-1 gap-1.5 overflow-x-auto px-4">
        {dates.map((d) => {
          const active = d === value;
          return (
            <button key={d} data-active={active} onClick={() => onChange(d)}
              className={cx('flex w-12 shrink-0 flex-col items-center rounded-xl py-1.5', active ? 'bg-pitch text-white' : 'bg-white text-ink border border-line')}>
              <span className={cx('text-[10px] font-bold uppercase', active ? 'text-white/70' : d === today ? 'text-pitch' : 'text-muted')}>{d === today ? 'Today' : fmtDay(d)}</span>
              <span className="text-lg font-bold leading-tight tabular">{Number(d.slice(8))}</span>
            </button>
          );
        })}
      </div>
      <label className="relative grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-line bg-white" title="Pick a date">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-pitch"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
        <input type="date" value={value} onChange={(e) => e.target.value && onChange(e.target.value)} className="absolute inset-0 opacity-0" aria-label="Pick a date" />
      </label>
    </div>
  );
}

export const monthLabel = (d: string) => fmtDate(d, { month: 'long', year: 'numeric' });
