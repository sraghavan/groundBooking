import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, type GroundAvailability } from '../api';
import { useCities, useMe } from '../hooks';
import { fmtLong, todayISO } from '../lib';
import { Card, Chip, Empty, ErrorNote, Page, PageHeader, Spinner } from '../components/ui';
import { DateStrip, Legend, SlotTile } from '../components/slots';

export function HomePage() {
  const [params, setParams] = useSearchParams();
  const date = params.get('date') ?? todayISO();
  const cityId = params.get('city') ?? '';
  const me = useMe();
  const cities = useCities();

  const q = useQuery({
    queryKey: ['availability', date, cityId],
    queryFn: () => api<GroundAvailability[]>(`/availability?from=${date}&days=1${cityId ? `&cityId=${cityId}` : ''}`),
  });

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    setParams(next, { replace: true });
  };

  const totals = (q.data ?? []).flatMap((g) => g.days[0]?.slots ?? []).reduce((t, s) => ({ ...t, [s.state]: t[s.state] + 1 }), { free: 0, partial: 0, full: 0 });

  return (
    <>
      <PageHeader
        title={me.data?.org.name ?? 'Grounds'}
        action={<Link to={`/bookings/new?date=${date}`} className="rounded-full bg-pitch px-4 py-2 text-sm font-semibold text-white">+ Book</Link>}
        sub={
          <div className="space-y-3">
            <DateStrip value={date} onChange={(d) => update({ date: d })} />
            {(cities.data?.length ?? 0) > 1 && (
              <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
                <Chip active={!cityId} onClick={() => update({ city: '' })}>All cities</Chip>
                {cities.data!.map((c) => <Chip key={c.id} active={cityId === c.id} onClick={() => update({ city: c.id })}>{c.name}</Chip>)}
              </div>
            )}
          </div>
        }
      />
      <Page>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-semibold">{fmtLong(date)}</p>
          {q.data && q.data.length > 0 && <p className="text-xs font-semibold text-muted tabular">{totals.free} free · {totals.partial} half · {totals.full} booked</p>}
        </div>
        <div className="mb-4"><Legend /></div>
        <ErrorNote error={q.error} />
        {q.isLoading ? <Spinner /> : q.data?.length === 0 ? (
          <Empty title="No grounds yet">
            <Link className="font-semibold text-pitch underline" to="/admin/grounds/new">Add your first ground</Link> to start taking bookings.
          </Empty>
        ) : (
          <div className="space-y-3">
            {q.data?.map((g) => {
              const slots = g.days[0]?.slots ?? [];
              return (
                <Card key={g.groundId} className="p-3">
                  <div className="mb-2 flex items-center gap-2 px-1">
                    <Link to={`/grounds/${g.groundId}/week?date=${date}`} className="min-w-0 flex-1">
                      <h2 className="truncate text-[17px] font-bold">{g.groundName}</h2>
                      <p className="text-xs font-medium text-muted">{g.cityName} · week view ›</p>
                    </Link>
                    <Link to={`/bookings/new?groundId=${g.groundId}&date=${date}`} className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold text-pitch">Custom time</Link>
                  </div>
                  {slots.length === 0 ? (
                    <p className="px-1 py-2 text-sm text-muted">No slots set for this day. <Link className="font-semibold text-pitch" to={`/admin/grounds/${g.groundId}`}>Add slots</Link></p>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      {slots.map((s) => <SlotTile key={s.key} cell={s} groundId={g.groundId} date={date} />)}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </Page>
    </>
  );
}
