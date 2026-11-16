import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type GroundAvailability, type SlotCell } from '../api';
import { useGrounds, usePromoters } from '../hooks';
import { addDays, cx, fmtDate, fmtDay, fmtMobile, fmtRange, inr, parseISO, todayISO } from '../lib';
import { Button, Card, ConfirmSheet, ErrorNote, Field, Input, MoneyInput, Page, PageHeader, Select, Spinner } from '../components/ui';
import { bookingText } from '../components/SlotTable';

/** A ticked slot. Times are kept so overlaps between ticks can be checked even across grounds. */
type Pick = { groundId: string; slotTemplateId: string; date: string; startTime: string; endTime: string; override?: boolean };
const toItem = ({ groundId, slotTemplateId, date }: Pick) => ({ groundId, slotTemplateId, date });
const keyOf = (p: Pick) => `${p.groundId}|${p.date}|${p.slotTemplateId}`;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_DAYS = 31;

/**
 * Group booking for a promoter: choose the promoter, a date range (optionally
 * only some weekdays), then tick free slots in a dates × slots table. Ticks
 * are kept when switching grounds, so one booking can span several grounds.
 */
export function GroupBookingPage() {
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const promoters = usePromoters();
  const grounds = useGrounds();
  const [promoterId, setPromoterId] = useState('');
  const [groundId, setGroundId] = useState('');
  const [from, setFrom] = useState(params.get('from') ?? todayISO());
  const [to, setTo] = useState(addDays(params.get('from') ?? todayISO(), 13));
  const [days, setDays] = useState<Set<number>>(new Set([0, 1, 2, 3, 4, 5, 6]));
  const [picked, setPicked] = useState<Map<string, Pick>>(new Map());
  const [rate, setRate] = useState<number | ''>('');
  const [clashKeys, setClashKeys] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ count: number; total: number; promoter: string } | null>(null);
  const [ask, setAsk] = useState<{ pick: Pick; conflicts: string[] } | null>(null);

  const groundsAZ = useMemo(() => [...(grounds.data ?? [])].filter((g) => g.active).sort((a, b) => a.name.localeCompare(b.name)), [grounds.data]);
  useEffect(() => { if (!groundId && groundsAZ.length) setGroundId(groundsAZ[0].id); }, [groundsAZ, groundId]);
  const promoter = promoters.data?.find((p) => p.id === promoterId);
  useEffect(() => { setRate(promoter?.defaultRate ?? ''); }, [promoter?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const span = Math.round((parseISO(to).getTime() - parseISO(from).getTime()) / 86_400_000) + 1;
  const rangeError = span < 1 ? 'The end date is before the start date' : span > MAX_DAYS ? `Choose up to ${MAX_DAYS} days at a time` : null;
  const avail = useQuery({
    queryKey: ['availability-range', groundId, from, span],
    queryFn: () => api<GroundAvailability[]>(`/availability?from=${from}&days=${span}&groundId=${groundId}`),
    enabled: !!groundId && !rangeError,
  });

  const ground = grounds.data?.find((g) => g.id === groundId);
  const columns = (ground?.slots ?? []).filter((s) => s.active).sort((a, b) => a.startTime.localeCompare(b.startTime) || a.sortOrder - b.sortOrder);
  const rows = (avail.data?.[0]?.days ?? []).filter((d) => days.has(parseISO(d.date).getDay()));

  /** State of slot column t on a day: free (tickable), a booking, covered by another booking, or not offered. */
  function cellFor(day: { date: string; slots: SlotCell[] }, t: (typeof columns)[number]) {
    const free = day.slots.find((c) => !c.booking && c.slotTemplateId === t.id);
    if (free) return { kind: 'free' as const, cell: free };
    const booked = day.slots.find((c) => c.booking && c.slotTemplateId === t.id);
    if (booked) return { kind: 'booked' as const, cell: booked };
    if (t.daysOfWeek.includes(parseISO(day.date).getDay())) return { kind: 'taken' as const };
    return { kind: 'none' as const };
  }

  function toggle(list: Pick[], on?: boolean) {
    setPicked((m) => {
      const next = new Map(m);
      const allOn = list.every((p) => next.has(keyOf(p)));
      const want = on ?? !allOn;
      list.forEach((p) => (want ? next.set(keyOf(p), p) : next.delete(keyOf(p))));
      return next;
    });
    setDone(null);
  }
  const pickOf = (t: (typeof columns)[number], date: string): Pick => ({ groundId, slotTemplateId: t.id, date, startTime: t.startTime, endTime: t.endTime });
  const list = [...picked.values()];
  const overlapsPick = (p: Pick, o: Pick) => keyOf(o) !== keyOf(p) && o.groundId === p.groundId && o.date === p.date && o.startTime < p.endTime && p.startTime < o.endTime;

  /**
   * Why a free slot can't simply be ticked: it overlaps an existing booking, or a
   * slot already ticked (e.g. Morning ticked → Late morning clashes). Empty = OK.
   */
  function conflictsOf(c: SlotCell, p: Pick, ticks: Pick[] = list): string[] {
    return [
      ...(c.overlaps ?? []).map((o) => `${fmtRange(o.startTime, o.endTime)} · ${o.label} (already booked)`),
      ...ticks.filter((o) => overlapsPick(p, o)).map((o) => `${fmtRange(o.startTime, o.endTime)} · ${columns.find((t) => t.id === o.slotTemplateId)?.name ?? 'slot'} (ticked here)`),
    ];
  }
  /** Row/column shortcuts tick only slots with no clash, so Morning and Late morning are never both ticked silently. */
  function clearOf(cells: { t: (typeof columns)[number]; date: string; day: (typeof rows)[number] }[]): Pick[] {
    const out: Pick[] = [];
    for (const { t, date, day } of cells) {
      const c = cellFor(day, t);
      if (c.kind !== 'free') continue;
      const p = pickOf(t, date);
      if (picked.has(keyOf(p))) { out.push(p); continue; }
      if (!conflictsOf(c.cell, p, [...list, ...out]).length) out.push(p);
    }
    return out;
  }
  const freeIn = (day: (typeof rows)[number]) => clearOf(columns.map((t) => ({ t, date: day.date, day })));
  const freeInColumn = (t: (typeof columns)[number]) => clearOf(rows.map((day) => ({ t, date: day.date, day })));
  const overrides = list.filter((p) => p.override).length;
  const onOtherGrounds = list.filter((p) => p.groundId !== groundId).length;
  const total = rate === '' ? null : rate * list.length;

  async function book() {
    setError(null);
    if (!promoterId) return setError(new Error('Choose the promoter'));
    if (!list.length) return setError(new Error('Tick at least one free slot'));
    setBusy(true);
    try {
      // Only slots the user confirmed in the "are you sure?" box are sent as double-bookings.
      const items = list.map((p) => ({ ...toItem(p), ...(p.override ? { allowOverlap: true } : {}) }));
      const res = await api<{ count: number; totalDue: number }>('/bookings/bulk', { body: { teamId: promoterId, items, ...(rate !== '' ? { amountDue: rate } : {}) } });
      setDone({ count: res.count, total: res.totalDue, promoter: promoter?.name ?? '' });
      setPicked(new Map());
      setClashKeys(new Set());
      await Promise.all(['availability', 'availability-week', 'availability-range', 'dues', 'report'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    } catch (err) {
      setError(err);
      const clashes = err instanceof ApiError && err.status === 409 ? (err.details as { clashes?: (Pick & { reason: string })[] })?.clashes : undefined;
      if (clashes) {
        setClashKeys(new Set(clashes.map(keyOf)));
        setPicked((m) => { const next = new Map(m); clashes.forEach((c) => next.delete(keyOf(c))); return next; });
        qc.invalidateQueries({ queryKey: ['availability-range'] });
      }
    } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Group booking" back="/" />
      <Page className="max-w-5xl space-y-4">
        <Card className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label="Promoter" hint={promoter ? `${promoter.poc ? fmtMobile(promoter.poc.mobile) + ' · ' : ''}${promoter.defaultRate != null ? `${inr(promoter.defaultRate)} per match` : 'No rate set'}` : undefined}>
            <Select value={promoterId} onChange={(e) => { setPromoterId(e.target.value); setDone(null); }}>
              <option value="" disabled>Choose a promoter</option>
              {promoters.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="Ground" hint={onOtherGrounds ? `${onOtherGrounds} slot${onOtherGrounds > 1 ? 's' : ''} also ticked on other grounds` : 'Ticks are kept if you switch ground'}>
            <Select value={groundId} onChange={(e) => setGroundId(e.target.value)}>
              {groundsAZ.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </Select>
          </Field>
          <Field label="From"><Input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></Field>
          <div className="sm:col-span-2">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Days</span>
            <div className="flex flex-wrap gap-1.5">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <button key={d} type="button" onClick={() => setDays((s) => { const n = new Set(s); n.has(d) ? n.delete(d) : n.add(d); return n; })}
                  className={cx('h-8 w-12 rounded-lg border text-sm font-semibold', days.has(d) ? 'border-pitch bg-pitch text-white' : 'border-line bg-white text-muted')}>{DOW[d]}</button>
              ))}
              <button type="button" className="ml-1 text-sm font-semibold text-pitch" onClick={() => setDays(new Set([0, 6]))}>Weekends</button>
              <button type="button" className="ml-1 text-sm font-semibold text-pitch" onClick={() => setDays(new Set([0, 1, 2, 3, 4, 5, 6]))}>All</button>
            </div>
          </div>
        </Card>

        {done && (
          <div className="flex items-center justify-between rounded-xl bg-free-bg px-3 py-2.5 text-sm font-semibold text-free">
            ✓ Booked {done.count} slot{done.count > 1 ? 's' : ''} for {done.promoter} · {inr(done.total)} due
            <Link to="/" className="underline">Back to slots</Link>
          </div>
        )}

        {rangeError ? <ErrorNote error={new Error(rangeError)} /> : avail.isLoading || !ground ? <Spinner /> : !columns.length ? (
          <p className="text-sm text-muted">This ground has no slots. <Link to={`/admin/grounds/${groundId}`} className="font-semibold text-pitch">Add slots</Link></p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-line bg-card">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-paper">
                  <th className="sticky left-0 z-10 bg-paper px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-muted">Date</th>
                  {columns.map((t) => {
                    const free = freeInColumn(t);
                    return (
                      <th key={t.id} className="min-w-[7.5rem] px-2 py-2 text-left align-bottom">
                        <button type="button" disabled={!free.length} onClick={() => toggle(free)} className="text-left disabled:opacity-60" title="Tick every free date in this slot">
                          <div className="text-[13px] font-bold">{t.name}</div>
                          <div className="text-xs font-medium text-muted tabular">{fmtRange(t.startTime, t.endTime)}</div>
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {!rows.length && <tr><td colSpan={columns.length + 1} className="px-3 py-6 text-center text-muted">No days match. Pick some days above.</td></tr>}
                {rows.map((d) => {
                  const free = freeIn(d);
                  const isWeekend = [0, 6].includes(parseISO(d.date).getDay());
                  return (
                    <tr key={d.date} className="border-t border-line/70">
                      <td className="sticky left-0 z-10 bg-card px-3 py-1.5">
                        <button type="button" disabled={!free.length} onClick={() => toggle(free)} className="text-left disabled:opacity-60" title="Tick every free slot this day">
                          <span className={cx('font-bold', isWeekend && 'text-pitch')}>{fmtDay(d.date)}</span> <span className="tabular">{fmtDate(d.date)}</span>
                        </button>
                      </td>
                      {columns.map((t) => {
                        const c = cellFor(d, t);
                        const p = pickOf(t, d.date);
                        const on = picked.has(keyOf(p));
                        if (c.kind === 'free') {
                          const mine = picked.get(keyOf(p));
                          const conflicts = on ? [] : conflictsOf(c.cell, p);
                          const blocked = conflicts.length > 0;
                          return (
                            <td key={t.id} className="px-2 py-1.5">
                              <button type="button" aria-pressed={on} aria-disabled={blocked} aria-label={`${t.name} on ${fmtDate(d.date)}${blocked ? ' (clashes)' : ''}`}
                                onClick={() => (blocked ? setAsk({ pick: p, conflicts }) : toggle([p]))}
                                className={cx('flex h-9 w-full items-center justify-center rounded-lg border text-xs font-semibold transition-colors',
                                  mine?.override ? 'border-partial bg-partial text-white'
                                    : on ? 'border-pitch bg-pitch text-white'
                                    : blocked ? 'cursor-not-allowed border-line bg-line/40 text-muted line-through decoration-muted/50'
                                    : clashKeys.has(keyOf(p)) ? 'border-full/40 bg-full-bg text-full' : 'border-free/30 bg-free-bg text-free')}>
                                {mine?.override ? '✓ Double-book' : on ? '✓ ' + (promoter?.name ?? 'Picked') : blocked ? 'Clashes' : 'Free'}
                              </button>
                            </td>
                          );
                        }
                        if (c.kind === 'booked') return (
                          <td key={t.id} className="px-2 py-1.5">
                            <Link to={`/bookings/${c.cell.booking!.id}`} className={cx('block truncate rounded-lg px-2 py-2 text-xs font-semibold', c.cell.state === 'partial' ? 'bg-partial-bg text-partial' : 'bg-full-bg text-full')} title={bookingText(c.cell)}>
                              {bookingText(c.cell)}
                            </Link>
                          </td>
                        );
                        return <td key={t.id} className="px-2 py-1.5 text-center text-xs text-muted">{c.kind === 'taken' ? 'Taken' : '—'}</td>;
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted">Tap a slot name to tick that slot on every free date; tap a date to tick every free slot that day. Slots that clash with a booking or a ticked slot are greyed out: tap one to double-book it on purpose.</p>

        {ask && (
          <ConfirmSheet title="This slot clashes" confirmLabel="Yes, double-book it"
            onCancel={() => setAsk(null)}
            onConfirm={() => { toggle([{ ...ask.pick, override: true }], true); setAsk(null); }}>
            <p><b>{columns.find((t) => t.id === ask.pick.slotTemplateId)?.name} {fmtRange(ask.pick.startTime, ask.pick.endTime)}</b> on <b>{fmtDay(ask.pick.date)} {fmtDate(ask.pick.date)}</b> overlaps:</p>
            <ul className="my-2 list-disc space-y-0.5 pl-5">{ask.conflicts.map((c) => <li key={c}>{c}</li>)}</ul>
            <p>The ground would be double-booked for the overlapping time. Are you sure you still want to book this slot?</p>
          </ConfirmSheet>
        )}

        <ErrorNote error={error} />

        <div className="pb-safe sticky bottom-16 z-10 -mx-4 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Rate per slot" className="w-36">
              <MoneyInput value={rate} onChange={setRate} placeholder="Default" />
            </Field>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-muted">{list.length} slot{list.length === 1 ? '' : 's'}{overrides > 0 && <span className="text-partial"> · {overrides} double-booked on purpose</span>}{list.length > 0 && <button type="button" className="ml-2 text-pitch" onClick={() => setPicked(new Map())}>Clear</button>}</div>
              <div className="text-lg font-bold tabular">{total != null ? inr(total) : list.length ? 'Default prices' : inr(0)}</div>
            </div>
            <Button disabled={busy || !list.length || !promoterId} onClick={book} className="min-w-36">
              {busy ? 'Booking…' : `Book ${list.length || ''} slot${list.length === 1 ? '' : 's'}`}
            </Button>
          </div>
        </div>
      </Page>
    </>
  );
}
