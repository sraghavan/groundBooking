import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, EVENT_LABEL, type BookedBy, type Booking, type BookingKind, type BookingStatus, type EventType, type Quote, type SlotCell } from '../api';
import { useAccounts, usePromoters, useTeams } from '../hooks';
import { cx, fmtDate, fmtMobile, fmtRange, inr, todayISO } from '../lib';
import { Button, ConfirmSheet, ErrorNote, MoneyInput, Select, Spinner } from './ui';
import { TeamPicker, type TeamRef } from './TeamPicker';

const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
type Party = TeamRef & { amount: number | ''; touched: boolean };
const blank = (): Party => ({ teamName: '', amount: '', touched: false });

/**
 * Inline booking form shown under a free slot row on the Slots screen.
 * Covers the everyday cases (2 teams, a promoter, a client event); the full
 * booking page is one tap away for anything more (custom times, tournaments…).
 */
export function QuickBook({ groundId, date, cell, onSaved, onCancel }: {
  groundId: string; date: string; cell: SlotCell; onSaved: () => void; onCancel: () => void;
}) {
  const qc = useQueryClient();
  const teams = useTeams();
  const promoters = usePromoters();
  const [kind, setKind] = useState<BookingKind>('match');
  const [bookedBy, setBookedBy] = useState<BookedBy>('direct');
  const [eventType, setEventType] = useState<EventType>('half_day');
  const [parties, setParties] = useState<Party[]>([blank(), blank()]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [askOverlap, setAskOverlap] = useState(false);

  // Layout: Team 1 + Team 2, one client, or one promoter. Promoters and teams never carry over.
  function arrange(k: BookingKind, by: BookedBy) {
    const keep = by === bookedBy ? parties.filter((p) => p.teamId || p.teamName.trim()) : [];
    setKind(k);
    setBookedBy(by);
    setParties(by === 'promoter' || k === 'event' ? [keep[0] ?? blank()] : [keep[0] ?? blank(), keep[1] ?? blank()]);
  }

  // Pre-fill amounts from the admin defaults unless typed.
  const key = parties.map((p) => `${p.teamId ?? p.teamName}:${p.touched}`).join('|');
  useEffect(() => {
    let stale = false;
    parties.forEach(async (p, i) => {
      if (p.touched || (!p.teamId && !p.teamName.trim())) return;
      const qs = new URLSearchParams({ groundId, kind, bookedBy, ...(cell.slotTemplateId ? { slotTemplateId: cell.slotTemplateId } : {}), ...(p.teamId ? { teamId: p.teamId } : {}), ...(kind === 'event' ? { eventType } : {}) });
      try {
        const q = await api<Quote>(`/pricing/quote?${qs}`);
        if (!stale) setParties((ps) => ps.map((x, j) => (j === i && !x.touched ? { ...x, amount: q.price } : x)));
      } catch { /* leave blank */ }
    });
    return () => { stale = true; };
  }, [key, kind, bookedBy, eventType]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (i: number, patch: Partial<Party>) => setParties((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const named = parties.filter((p) => p.teamId || p.teamName.trim());
  const total = named.reduce((s, p) => s + (p.amount || 0), 0);

  async function save(e?: FormEvent, allowOverlap = false) {
    e?.preventDefault();
    setError(null);
    if (bookedBy === 'promoter' && !parties[0]?.teamId) return setError(new Error('Choose the promoter'));
    const ambiguous = parties.find((p) => !p.teamId && p.teamName.trim() && !p.newTeam && (teams.data ?? []).some((t) => nameKey(t.name) === nameKey(p.teamName)));
    if (ambiguous) return setError(new Error(`Pick which “${ambiguous.teamName.trim()}” you mean, or mark it as a new team.`));
    if (cell.overlaps?.length && !allowOverlap) return setAskOverlap(true);
    setAskOverlap(false);
    setBusy(true);
    try {
      await api('/bookings', { body: {
        groundId, date, slotTemplateId: cell.slotTemplateId, startTime: cell.startTime, endTime: cell.endTime,
        kind, bookedBy, ...(kind === 'event' ? { eventType, ...(eventType === 'tournament' ? { matchCount: 1 } : {}) } : {}),
        allowOverlap,
        parties: named.map((p, i) => ({
          side: bookedBy === 'promoter' || kind === 'event' ? 'client' : i === 0 ? 'A' : 'B',
          ...(p.teamId ? { teamId: p.teamId } : { teamName: p.teamName.trim(), ...(p.newTeam ? { newTeam: true } : {}),
            ...(p.contactName?.trim() && p.contactMobile?.trim() ? { contact: { name: p.contactName.trim(), mobile: p.contactMobile.trim() } } : {}) }),
          ...(p.amount !== '' ? { amountDue: p.amount } : {}),
        })),
      } });
      await Promise.all(['availability', 'availability-week', 'availability-range', 'dues', 'teams', 'report'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && (err.details as { clashes?: unknown })?.clashes) setAskOverlap(true);
      else setError(err);
    } finally { setBusy(false); }
  }

  const label = (i: number) => (bookedBy === 'promoter' ? 'Promoter' : kind === 'event' ? 'Client' : `Team ${i + 1}`);
  const fullForm = `/bookings/new?groundId=${groundId}&date=${date}${cell.slotTemplateId ? `&slot=${cell.slotTemplateId}` : ''}`;

  return (
    <form onSubmit={save} className="space-y-3 border-t border-pitch/20 bg-pitch/[0.03] px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="!h-10 !w-auto min-w-28" value={kind} onChange={(e) => arrange(e.target.value as BookingKind, bookedBy)} aria-label="Booking type">
          <option value="match">Match</option><option value="event">Event</option>
        </Select>
        <Select className="!h-10 !w-auto min-w-32" value={bookedBy} onChange={(e) => arrange(kind, e.target.value as BookedBy)} aria-label="Booked by">
          <option value="direct">{kind === 'match' ? '2 teams' : 'Client'}</option><option value="promoter">Promoter</option>
        </Select>
        {kind === 'event' && (
          <Select className="!h-10 !w-auto" value={eventType} onChange={(e) => setEventType(e.target.value as EventType)} aria-label="Event type">
            {(Object.keys(EVENT_LABEL) as EventType[]).map((t) => <option key={t} value={t}>{EVENT_LABEL[t]}{t === 'tournament' ? ' (1 match)' : ''}</option>)}
          </Select>
        )}
        <Link to={fullForm} className="ml-auto text-xs font-semibold text-pitch">More options ›</Link>
      </div>

      {cell.overlaps?.length ? (
        <p className="rounded-lg bg-partial-bg px-3 py-2 text-xs font-semibold text-partial">
          ⚠ Overlaps {cell.overlaps.map((o) => `${fmtRange(o.startTime, o.endTime)} ${o.label}`).join(', ')}. You'll be asked to confirm.
        </p>
      ) : null}

      <div className={cx('grid gap-3', parties.length > 1 && 'sm:grid-cols-2')}>
        {parties.map((p, i) => (
          <div key={i} className="space-y-2">
            <div className="text-xs font-bold uppercase tracking-wide text-muted">{label(i)}</div>
            {bookedBy === 'promoter' ? (
              <Select className="!h-10" value={p.teamId ?? ''} onChange={(e) => { const t = promoters.data?.find((x) => x.id === e.target.value); set(i, { teamId: t?.id, teamName: t?.name ?? '', touched: false, amount: '' }); }}>
                <option value="" disabled>Choose a promoter</option>
                {promoters.data?.map((t) => <option key={t.id} value={t.id}>{t.name}{t.poc ? ` · ${fmtMobile(t.poc.mobile)}` : ''}</option>)}
              </Select>
            ) : (
              <TeamPicker value={p} teams={teams.data ?? []} exclude={parties.filter((_, j) => j !== i).map((x) => x.teamId).filter(Boolean) as string[]}
                placeholder={kind === 'event' ? 'Client name (+ POC for a new client)' : i === 0 ? 'Team name, POC or mobile' : 'Optional — leave empty if not known'}
                onChange={(v) => set(i, { ...v, touched: false, amount: '' })} />
            )}
            {(p.teamId || p.teamName.trim()) && (
              <div className="flex items-center gap-2">
                <MoneyInput className="flex-1 [&_input]:!h-10" value={p.amount} onChange={(v) => set(i, { amount: v, touched: true })} aria-label={`Amount for ${label(i)}`} />
                {p.touched && <button type="button" className="text-xs font-semibold text-pitch" onClick={() => set(i, { touched: false })}>Default</button>}
              </div>
            )}
          </div>
        ))}
      </div>

      <ErrorNote error={error} />
      <div className="flex items-center gap-2">
        <span className="flex-1 text-sm font-bold tabular">{named.length ? `Total ${inr(total)}` : ''}</span>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" disabled={busy || (bookedBy === 'promoter' && !parties[0]?.teamId)}>{busy ? 'Saving…' : 'Book'}</Button>
      </div>

      {askOverlap && (
        <ConfirmSheet title="This slot clashes" confirmLabel="Yes, double-book it" onCancel={() => setAskOverlap(false)} onConfirm={() => save(undefined, true)}>
          <p><b>{cell.name} {fmtRange(cell.startTime, cell.endTime)}</b> on <b>{fmtDate(date)}</b> overlaps another booking{cell.overlaps?.length ? ':' : '.'}</p>
          {cell.overlaps?.length ? <ul className="my-2 list-disc space-y-0.5 pl-5">{cell.overlaps.map((o) => <li key={o.bookingId}>{fmtRange(o.startTime, o.endTime)} · {o.label}</li>)}</ul> : null}
          <p>The ground would be double-booked for the overlapping time. Are you sure you still want to book this slot?</p>
        </ConfirmSheet>
      )}
    </form>
  );
}

/** Details of a booked slot, shown under its row: who, amounts, status, and recording payments in place. */
export function BookingDetails({ bookingId }: { bookingId: string }) {
  const q = useQuery({ queryKey: ['booking', bookingId], queryFn: () => api<Booking>(`/bookings/${bookingId}`) });
  const qc = useQueryClient();
  const accounts = useAccounts();
  const [payFor, setPayFor] = useState<string | null>(null);      // party id with the payment form open
  const [amounts, setAmounts] = useState<Record<string, number | ''> | null>(null); // editing amounts (Part played)
  const [askCancel, setAskCancel] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const b = q.data;
  if (q.isLoading) return <div className="border-t border-line/70"><Spinner /></div>;
  if (!b) return <div className="px-4 py-3"><ErrorNote error={q.error} /></div>;
  const type = b.kind === 'event' ? `Event${b.eventType ? ` · ${EVENT_LABEL[b.eventType]}${b.eventType === 'tournament' && b.matchCount ? ` (${b.matchCount} matches)` : ''}` : ''}` : 'Match';
  const role = (side: string, i: number) => (b.bookedBy === 'promoter' ? 'Promoter' : b.kind === 'event' ? (b.parties.length > 1 ? `Client ${i + 1}` : 'Client') : side === 'A' ? 'Team 1' : 'Team 2');
  const acctName = (id: string | null) => (id ? accounts.data?.find((a) => a.id === id)?.name : undefined);

  const refresh = () => Promise.all(['booking', 'availability', 'availability-week', 'availability-range', 'dues', 'report'].map((k) => qc.invalidateQueries({ queryKey: [k] })));

  /** Status change; with `newAmounts`, also sets each party's amount (Part played / cancellation charge). */
  async function setStatus(status: BookingStatus, newAmounts?: Record<string, number>) {
    setBusy(true);
    setError(null);
    try {
      await api(`/bookings/${b!.id}`, { method: 'PATCH', body: {
        status,
        ...(newAmounts ? { parties: b!.parties.map((p) => ({ id: p.id, side: p.side, teamId: p.teamId, amountDue: newAmounts[p.id] ?? p.amountDue })) } : {}),
      } });
      setAmounts(null);
      setAskCancel(false);
      await refresh();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  const statuses: { v: BookingStatus; label: string }[] = [
    { v: 'confirmed', label: 'Upcoming' }, { v: 'completed', label: 'Played' }, { v: 'partial', label: 'Part played' }, { v: 'cancelled', label: 'Cancel' },
  ];

  return (
    <div className="space-y-2 border-t border-pitch/20 bg-pitch/[0.03] px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold">{type}{b.bookedBy === 'promoter' ? ' · by promoter' : ''}</span>
        {b.title && <span className="text-muted">· {b.title}</span>}
        <Link to={`/bookings/${b.id}`} className="ml-auto font-semibold text-pitch">Edit booking ›</Link>
      </div>

      {/* Status */}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Status">
        {statuses.map((s) => (
          <button key={s.v} type="button" disabled={busy}
            onClick={() => {
              if (s.v === b.status) return;
              if (s.v === 'cancelled') return setAskCancel(true);
              if (s.v === 'partial') return setAmounts(Object.fromEntries(b.parties.map((p) => [p.id, p.amountDue])));
              setStatus(s.v);
            }}
            className={cx('h-8 rounded-full border px-3 text-xs font-semibold', s.v === b.status ? 'border-pitch bg-pitch text-white' : 'border-line bg-white text-ink')}>
            {s.label}
          </button>
        ))}
      </div>
      {amounts && (
        <div className="space-y-2 rounded-xl border border-partial/30 bg-partial-bg p-3">
          <p className="text-xs font-semibold text-partial">Not completed: set what each one pays now.</p>
          {b.parties.map((p) => (
            <label key={p.id} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-semibold">{p.teamName}</span>
              <MoneyInput className="w-32 [&_input]:!h-9" value={amounts[p.id] ?? ''} onChange={(v) => setAmounts({ ...amounts, [p.id]: v })} />
            </label>
          ))}
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setAmounts(null)}>Back</Button>
            <Button type="button" size="sm" disabled={busy} onClick={() => setStatus('partial', Object.fromEntries(Object.entries(amounts).map(([k, v]) => [k, v === '' ? 0 : v])))}>Save as part played</Button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-muted">
              <th className="py-1 pr-3 font-bold"> </th><th className="py-1 pr-3 font-bold">Name</th><th className="py-1 pr-3 font-bold">POC</th>
              <th className="py-1 pr-3 text-right font-bold">Amount</th><th className="py-1 pr-3 text-right font-bold">Paid</th><th className="py-1 pr-3 text-right font-bold">Balance</th><th />
            </tr>
          </thead>
          <tbody>
            {b.parties.map((p, i) => (
              <Fragment key={p.id}>
                <tr className="border-t border-line/60">
                  <td className="whitespace-nowrap py-1.5 pr-3 text-xs text-muted">{role(p.side, i)}</td>
                  <td className="py-1.5 pr-3 font-semibold">{p.teamName}</td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-muted">{p.pocName ? `${p.pocName}${p.pocMobile ? ` · ${fmtMobile(p.pocMobile)}` : ''}` : '—'}</td>
                  <td className="py-1.5 pr-3 text-right tabular">{inr(p.amountDue)}</td>
                  <td className="py-1.5 pr-3 text-right tabular">{inr(p.paid)}</td>
                  <td className={cx('py-1.5 pr-3 text-right font-semibold tabular', p.balance > 0 ? 'text-full' : 'text-free')}>{p.balance > 0 ? inr(p.balance) : p.balance < 0 ? `${inr(-p.balance)} extra` : '✓'}</td>
                  <td className="py-1.5 text-right">
                    <button type="button" className={cx('whitespace-nowrap rounded-lg px-2 py-1 text-xs font-semibold', payFor === p.id ? 'bg-line text-ink' : p.balance > 0 ? 'bg-pitch text-white' : 'text-pitch')}
                      onClick={() => setPayFor(payFor === p.id ? null : p.id)}>{payFor === p.id ? 'Close' : '+ Payment'}</button>
                  </td>
                </tr>
                {payFor === p.id && (
                  <tr><td colSpan={7} className="pb-2">
                    <InlinePayment bookingId={b.id} partyId={p.id} balance={p.balance} name={p.teamName}
                      onSaved={async () => { setPayFor(null); await refresh(); }} />
                  </td></tr>
                )}
              </Fragment>
            ))}
            {b.kind === 'match' && b.bookedBy === 'direct' && b.parties.length < 2 && (
              <tr className="border-t border-line/60"><td className="py-1.5 pr-3 text-xs text-muted">Team {b.parties.length + 1}</td><td colSpan={6} className="py-1.5 text-partial">Not known yet · <Link to={`/bookings/${b.id}`} className="font-semibold underline">add opponent</Link></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {b.payments && b.payments.length > 0 && (
        <div className="text-xs text-muted">
          <span className="font-semibold text-ink">Payments: </span>
          {b.payments.map((pm) => `${inr(pm.amount)} ${b.parties.find((x) => x.id === pm.bookingPartyId)?.teamName ?? ''} · ${pm.method.toUpperCase()}${acctName(pm.accountId) ? ` → ${acctName(pm.accountId)}` : ''} · ${fmtDate(pm.paidOn)}`).join('  |  ')}
        </div>
      )}
      {b.notes && <p className="text-xs text-muted">{b.notes}</p>}
      <ErrorNote error={error} />

      {askCancel && (
        <ConfirmSheet title="Cancel this booking?" confirmLabel="Cancel, no charge" onCancel={() => setAskCancel(false)}
          onConfirm={() => setStatus('cancelled', Object.fromEntries(b.parties.map((p) => [p.id, p.paid])))}>
          <p>The slot becomes free again. You can cancel with no charge (what's owed drops to what's already paid), or keep the full amounts as a cancellation charge.</p>
          <Button type="button" variant="secondary" className="mt-3 w-full" onClick={() => setStatus('cancelled')}>Cancel, keep charges</Button>
        </ConfirmSheet>
      )}
    </div>
  );
}

/** Record a payment in one line under the party's row: Amount | Mode | Date | Into | Pending | Record. */
function InlinePayment({ bookingId, partyId, balance, name, onSaved }: { bookingId: string; partyId: string; balance: number; name: string; onSaved: () => void }) {
  const accounts = useAccounts();
  const live = (accounts.data ?? []).filter((a) => a.active);
  const [amount, setAmount] = useState<number | ''>(balance > 0 ? balance : '');
  const [method, setMethod] = useState<'upi' | 'cash' | 'bank'>('upi');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [paidOn, setPaidOn] = useState(todayISO());
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const chosen = accountId ?? live.find((a) => a.isDefault)?.id ?? live[0]?.id ?? null;
  const pending = balance - (amount || 0);

  async function submit() {
    if (!amount) return setError(new Error('Enter an amount'));
    setBusy(true);
    setError(null);
    try {
      await api(`/bookings/${bookingId}/payments`, { body: { bookingPartyId: partyId, amount, method, paidOn, accountId: method === 'cash' ? null : chosen } });
      onSaved();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  const field = 'h-9 rounded-lg border border-line bg-white px-2';
  const th = 'px-2 py-1 text-left text-[11px] font-bold uppercase tracking-wide text-muted';
  return (
    <div className="rounded-xl border border-line bg-white text-[13px] [&_input]:!text-[13px] [&_select]:!text-[13px] [&_button]:!text-[13px]">
      <table className="w-full" aria-label={`Payment from ${name}`}>
        <thead>
          <tr><th className={th}>Amount</th><th className={th}>Mode</th><th className={th}>Date</th><th className={th}>Into</th><th className={cx(th, 'text-right')}>Pending</th><th /></tr>
        </thead>
        <tbody>
          <tr>
            <td className="px-2 pb-2"><MoneyInput className="w-28 [&_input]:!h-9" value={amount} onChange={setAmount} aria-label="Amount received" /></td>
            <td className="px-2 pb-2">
              <select className={field} value={method} onChange={(e) => setMethod(e.target.value as typeof method)} aria-label="Mode">
                <option value="upi">UPI</option><option value="cash">Cash</option><option value="bank">Bank</option>
              </select>
            </td>
            <td className="px-2 pb-2"><input type="date" className={field} value={paidOn} onChange={(e) => e.target.value && setPaidOn(e.target.value)} aria-label="Date received" /></td>
            <td className="px-2 pb-2">
              {method === 'cash' || live.length === 0 ? <span className="text-muted">—</span> : (
                <select className={cx(field, 'max-w-40')} value={chosen ?? ''} onChange={(e) => setAccountId(e.target.value)} aria-label="Into account">
                  {live.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              )}
            </td>
            <td className={cx('whitespace-nowrap px-2 pb-2 text-right font-semibold tabular', pending > 0 ? 'text-full' : 'text-free')}>
              {pending > 0 ? inr(pending) : pending < 0 ? `${inr(-pending)} extra` : 'Nil'}
            </td>
            <td className="px-2 pb-2 text-right">
              <Button type="button" size="sm" className="whitespace-nowrap" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Record payment'}</Button>
            </td>
          </tr>
        </tbody>
      </table>
      {!!error && <div className="px-2 pb-2"><ErrorNote error={error} /></div>}
    </div>
  );
}
