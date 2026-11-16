import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { Inline } from './Home';
import { useQuery } from '@tanstack/react-query';
import { api, type GroundAvailability } from '../api';
import { addDays, cx, fmtDate, fmtDay, startOfWeek, todayISO } from '../lib';
import { Button, ErrorNote, Page, PageHeader, Spinner } from '../components/ui';
import { rowId, SlotTable, StatusFilter, type SlotFilter, type SlotGroup, type SlotRow } from '../components/SlotTable';

/** Seven-day table of one ground, grouped by day, filterable by status. */
export function GroundWeekPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const weekStart = startOfWeek(params.get('date') ?? todayISO());
  const filter = (params.get('status') ?? 'all') as SlotFilter;
  const q = useQuery({
    queryKey: ['availability-week', id, weekStart],
    queryFn: () => api<GroundAvailability[]>(`/availability?from=${weekStart}&days=7&groundId=${id}`),
  });
  const g = q.data?.[0];
  const today = todayISO();
  const set = (date: string, status: SlotFilter) => setParams({ date, ...(status !== 'all' ? { status } : {}) }, { replace: true });

  const [expanded, setExpanded] = useState<string | null>(null);
  const groups: SlotGroup[] = (g?.days ?? []).map((d) => ({
    key: d.date,
    title: (
      <span className="flex items-center gap-2">
        <span className={cx('font-bold', d.date === today && 'text-pitch')}>{fmtDay(d.date)} {fmtDate(d.date)}</span>
        {d.date === today && <span className="rounded-full bg-pitch px-2 py-0.5 text-[10px] font-bold uppercase text-white">Today</span>}
      </span>
    ),
    actions: <Link to={`/bookings/new?groundId=${id}&date=${d.date}`} className="text-xs font-semibold text-pitch">+ Custom time</Link>,
    rows: d.slots.map((cell) => ({ key: `${d.date}:${cell.key}`, groundId: id!, date: d.date, cell })),
  }));

  return (
    <>
      <PageHeader title={g?.groundName ?? 'Ground'} back="/" sub={
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => set(addDays(weekStart, -7), filter)} aria-label="Previous week">‹</Button>
            <div className="flex-1 text-center text-sm font-semibold">{fmtDate(weekStart)} – {fmtDate(addDays(weekStart, 6), { day: 'numeric', month: 'short', year: 'numeric' })}</div>
            <Button variant="secondary" size="sm" onClick={() => set(addDays(weekStart, 7), filter)} aria-label="Next week">›</Button>
          </div>
          <StatusFilter value={filter} onChange={(f) => set(weekStart, f)} rows={groups.flatMap((x) => x.rows)} />
        </div>
      } />
      <Page className="max-w-4xl">
        <ErrorNote error={q.error} />
        {q.isLoading ? <Spinner /> : g && <SlotTable groups={groups} filter={filter}
          expanded={expanded} onRowClick={(r: SlotRow) => setExpanded(expanded === rowId(r) ? null : rowId(r))}
          renderExpanded={(r) => <Inline r={r} onClose={() => setExpanded(null)} />} />}
      </Page>
    </>
  );
}
