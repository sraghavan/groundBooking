import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, type GroundAvailability } from '../api';
import { useCities, useMe } from '../hooks';
import { fmtLong, todayISO } from '../lib';
import { Chip, Empty, ErrorNote, Page, PageHeader, Spinner } from '../components/ui';
import { DateStrip } from '../components/slots';
import { rowId, SlotTable, StatusFilter, type SlotFilter, type SlotGroup, type SlotRow } from '../components/SlotTable';
import { BookingDetails, QuickBook } from '../components/QuickBook';

/** Today's slots on every ground, as a table grouped by ground (A–Z), filterable by status. */
export function HomePage() {
  const [params, setParams] = useSearchParams();
  const date = params.get('date') ?? todayISO();
  const cityId = params.get('city') ?? '';
  const filter = (params.get('status') ?? 'all') as SlotFilter;
  const me = useMe();
  const cities = useCities();

  const q = useQuery({
    queryKey: ['availability', date, cityId],
    queryFn: () => api<GroundAvailability[]>(`/availability?from=${date}&days=1${cityId ? `&cityId=${cityId}` : ''}`),
  });

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => (v && v !== 'all' ? next.set(k, v) : next.delete(k)));
    setParams(next, { replace: true });
  };

  // Grounds are accordions, all collapsed when the screen opens.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  // Tapping a row opens a quick booking form (free slot) or the booking's details (booked) under it.
  const [expanded, setExpanded] = useState<string | null>(null);
  const groundsAZ = [...(q.data ?? [])].sort((a, b) => a.groundName.localeCompare(b.groundName));
  const groups: SlotGroup[] = groundsAZ.map((g) => ({
    key: g.groundId,
    title: <><span className="font-bold">{g.groundName}</span>{(cities.data?.length ?? 0) > 1 && <span className="text-xs text-muted"> · {g.cityName}</span>}</>,
    actions: (
      <span className="flex shrink-0 items-center gap-3 text-xs font-semibold text-pitch">
        <Link to={`/grounds/${g.groundId}/week?date=${date}`}>Week ›</Link>
        <Link to={`/bookings/new?groundId=${g.groundId}&date=${date}`} className="hidden sm:inline">+ Custom</Link>
      </span>
    ),
    rows: (g.days[0]?.slots ?? []).map((cell) => ({ key: `${g.groundId}:${cell.key}`, groundId: g.groundId, date, cell })),
    emptyNote: <>No slots this day. <Link className="font-semibold text-pitch" to={`/admin/grounds/${g.groundId}`}>Add slots</Link></>,
  }));
  const allRows = groups.flatMap((g) => g.rows);

  return (
    <>
      <PageHeader
        title={me.data?.org.name ?? 'Grounds'}
        action={
          <Link to={`/bookings/group?from=${date}`} className="rounded-full border border-pitch px-3.5 py-2 text-sm font-semibold text-pitch">Group booking</Link>
        }
        sub={
          <div className="space-y-3">
            <DateStrip value={date} onChange={(d) => update({ date: d })} />
            {(cities.data?.length ?? 0) > 1 && (
              <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
                <Chip active={!cityId} onClick={() => update({ city: '' })}>All cities</Chip>
                {cities.data!.map((c) => <Chip key={c.id} active={cityId === c.id} onClick={() => update({ city: c.id })}>{c.name}</Chip>)}
              </div>
            )}
            <StatusFilter value={filter} onChange={(f) => update({ status: f })} rows={allRows} />
          </div>
        }
      />
      <Page className="max-w-4xl">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-semibold">{fmtLong(date)}</p>
          {groups.length > 0 && (
            <button type="button" className="text-sm font-semibold text-pitch" onClick={() => setOpen(open.size === groups.length ? new Set() : new Set(groups.map((g) => g.key)))}>
              {open.size === groups.length ? 'Collapse all' : 'Expand all'}
            </button>
          )}
        </div>
        <ErrorNote error={q.error} />
        {q.isLoading ? <Spinner /> : q.data?.length === 0 ? (
          <Empty title="No grounds yet">
            <Link className="font-semibold text-pitch underline" to="/admin/grounds/new">Add your first ground</Link> to start taking bookings.
          </Empty>
        ) : <SlotTable groups={groups} filter={filter} open={open} onToggle={toggle}
          expanded={expanded} onRowClick={(r) => setExpanded(expanded === rowId(r) ? null : rowId(r))}
          renderExpanded={(r) => <Inline r={r} onClose={() => setExpanded(null)} />} />}
      </Page>
    </>
  );
}

/** What opens under a row: details of the booking, or a quick form to book the free slot. */
export function Inline({ r, onClose }: { r: SlotRow; onClose: () => void }) {
  return r.cell.booking
    ? <BookingDetails bookingId={r.cell.booking.id} />
    : <QuickBook groundId={r.groundId} date={r.date} cell={r.cell} onSaved={() => { /* row turns into the booking; its details stay open */ }} onCancel={onClose} />;
}
