import { useEffect, useRef } from 'react';
import { addDays, cx, fmtDate, fmtDay, todayISO } from '../lib';

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
