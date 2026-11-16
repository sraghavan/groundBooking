import { useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, type GroundAvailability } from '../api';
import { addDays, cx, fmtDate, fmtDay, startOfWeek, todayISO } from '../lib';
import { Button, ErrorNote, Page, PageHeader, Spinner } from '../components/ui';
import { Legend, SlotTile } from '../components/slots';

/** Seven-day view of one ground. */
export function GroundWeekPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const weekStart = startOfWeek(params.get('date') ?? todayISO());
  const q = useQuery({
    queryKey: ['availability-week', id, weekStart],
    queryFn: () => api<GroundAvailability[]>(`/availability?from=${weekStart}&days=7&groundId=${id}`),
  });
  const g = q.data?.[0];
  const go = (n: number) => setParams({ date: addDays(weekStart, n) }, { replace: true });
  const today = todayISO();

  return (
    <>
      <PageHeader title={g?.groundName ?? 'Ground'} back="/" sub={
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => go(-7)} aria-label="Previous week">‹</Button>
          <div className="flex-1 text-center text-sm font-semibold">{fmtDate(weekStart)} – {fmtDate(addDays(weekStart, 6), { day: 'numeric', month: 'short', year: 'numeric' })}</div>
          <Button variant="secondary" size="sm" onClick={() => go(7)} aria-label="Next week">›</Button>
        </div>
      } />
      <Page>
        <div className="mb-4"><Legend /></div>
        <ErrorNote error={q.error} />
        {q.isLoading ? <Spinner /> : g && (
          <div className="space-y-2">
            {g.days.map((d) => (
              <div key={d.date} className={cx('flex gap-3 rounded-2xl border bg-white p-2.5', d.date === today ? 'border-pitch' : 'border-line')}>
                <div className="w-11 shrink-0 pt-1 text-center">
                  <div className={cx('text-[10px] font-bold uppercase', d.date === today ? 'text-pitch' : 'text-muted')}>{fmtDay(d.date)}</div>
                  <div className="text-xl font-bold tabular">{Number(d.date.slice(8))}</div>
                </div>
                <div className="grid min-w-0 flex-1 grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {d.slots.length ? d.slots.map((s) => <SlotTile key={s.key} cell={s} groundId={g.groundId} date={d.date} />)
                    : <p className="py-2 text-sm text-muted">No slots</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Page>
    </>
  );
}
