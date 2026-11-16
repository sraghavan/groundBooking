import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, EVENT_LABEL, type Booking, type BookingKind, type BookingStatus, type EventType, type Party, type Payment, type Quote, type Side, type Team } from '../api';
import { useAccounts, useGrounds, usePromoters, useTeams } from '../hooks';
import { cx, fmtDate, fmtLong, fmtRange, inr, parseISO, pocLine, todayISO } from '../lib';
import { Button, Card, Chip, ErrorNote, Field, Input, MoneyInput, Page, PageHeader, Segmented, Select, Sheet, Spinner, StatusBadge, Textarea } from '../components/ui';
import { TeamPicker, type TeamRef } from '../components/TeamPicker';

type PartyRow = {
  key: string; id?: string; side: Side; teamId?: string; teamName: string;
  newTeam?: boolean; contactName?: string; contactMobile?: string;
  pocName?: string | null; pocMobile?: string | null;
  amountDue: number | ''; touched: boolean; paid: number; balance: number;
};

const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
const blankParty = (side: Side): PartyRow => ({ key: crypto.randomUUID(), side, teamName: '', amountDue: '', touched: false, paid: 0, balance: 0 });
const fromParty = (p: Party): PartyRow => ({ key: p.id, id: p.id, side: p.side, teamId: p.teamId, teamName: p.teamName, pocName: p.pocName, pocMobile: p.pocMobile, amountDue: p.amountDue, touched: true, paid: p.paid, balance: p.balance });

export function BookingPage() {
  const { id } = useParams();
  const isNew = !id;
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const grounds = useGrounds();
  const teams = useTeams();
  const teamList = teams.data ?? [];

  const existing = useQuery({ queryKey: ['booking', id], queryFn: () => api<Booking>(`/bookings/${id}`), enabled: !isNew });

  const [f, setF] = useState({
    groundId: params.get('groundId') ?? '', date: params.get('date') ?? todayISO(), slotTemplateId: params.get('slot') ?? '',
    startTime: '', endTime: '', kind: 'match' as BookingKind, title: '', status: 'confirmed' as BookingStatus, notes: '',
    eventType: 'half_day' as EventType | '', matchCount: 1 as number | '',
  });
  const promoters = usePromoters();
  const [parties, setParties] = useState<PartyRow[]>([blankParty('A'), blankParty('B')]);
  const [error, setError] = useState<unknown>(null);
  const [clash, setClash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(isNew);
  const [payFor, setPayFor] = useState<PartyRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Load an existing booking into the form.
  useEffect(() => {
    const b = existing.data;
    if (!b || loaded) return;
    setF({ groundId: b.groundId, date: b.date, slotTemplateId: b.slotTemplateId ?? '', startTime: b.startTime, endTime: b.endTime, kind: b.kind, title: b.title ?? '', status: b.status, notes: b.notes ?? '', eventType: b.eventType ?? '', matchCount: b.matchCount ?? 1 });
    const ps = b.parties.map(fromParty);
    if (b.kind === 'match') {
      setParties([ps.find((p) => p.side === 'A') ?? blankParty('A'), ps.find((p) => p.side === 'B') ?? blankParty('B')]);
    } else setParties(ps.length ? ps : [blankParty('client')]);
    setLoaded(true);
  }, [existing.data, loaded]);

  // Re-sync paid/balance after payments change without clobbering edits.
  useEffect(() => {
    const b = existing.data;
    if (!b || !loaded) return;
    setParties((rows) => rows.map((r) => { const p = b.parties.find((x) => x.id === r.id); return p ? { ...r, paid: p.paid, balance: p.balance } : r; }));
  }, [existing.data, loaded]);

  // Default to first ground for new bookings.
  useEffect(() => {
    if (isNew && !f.groundId && grounds.data?.length) setF((x) => ({ ...x, groundId: grounds.data!.find((g) => g.active)?.id ?? '' }));
  }, [grounds.data, isNew, f.groundId]);

  const ground = grounds.data?.find((g) => g.id === f.groundId);
  const dow = parseISO(f.date).getDay();
  const slotOptions = useMemo(() => (ground?.slots ?? []).filter((s) => s.active && s.daysOfWeek.includes(dow)), [ground, dow]);
  const slot = ground?.slots.find((s) => s.id === f.slotTemplateId);

  // Other bookings on this ground and date, so a taken slot shows up as soon as it's picked.
  const dayQ = useQuery({
    queryKey: ['bookings-day', f.groundId, f.date],
    queryFn: () => api<Booking[]>(`/bookings?from=${f.date}&to=${f.date}&groundId=${f.groundId}`),
    enabled: !!f.groundId && !!f.date,
  });
  const others = (dayQ.data ?? []).filter((x) => x.id !== id && x.status !== 'cancelled');
  const bookedFor = (s: { id: string; startTime: string; endTime: string }) => others.find((x) => x.slotTemplateId
    ? x.slotTemplateId === s.id || (x.startTime <= s.startTime && s.endTime <= x.endTime)
    : x.startTime < s.endTime && s.startTime < x.endTime);
  const overlapping = f.startTime && f.endTime && f.startTime < f.endTime
    ? others.filter((x) => x.startTime < f.endTime && f.startTime < x.endTime) : [];
  const fromSlot = params.get('existing') === '1';

  // New booking on a slot that's already taken → open that booking to edit instead.
  useEffect(() => {
    if (!isNew || !slot || !dayQ.data) return;
    const taken = bookedFor(slot);
    if (taken) nav(`/bookings/${taken.id}?existing=1`, { replace: true });
  }, [dayQ.data, slot?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function deleteOther(bk: Booking) {
    setError(null);
    try {
      await api(`/bookings/${bk.id}`, { method: 'DELETE' });
      await Promise.all(['bookings-day', 'availability', 'availability-week', 'dues', 'report'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    } catch (err) { setError(err); }
  }

  // When a slot preset is chosen on a new booking, copy its times (still editable).
  useEffect(() => {
    if (!isNew) return;
    if (slot) setF((x) => ({ ...x, startTime: slot.startTime, endTime: slot.endTime }));
  }, [slot?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-fill each team's price from the admin defaults unless the user has typed one.
  const priceKey = parties.map((p) => `${p.key}:${p.teamId ?? ''}:${p.touched}`).join('|');
  useEffect(() => {
    if (!f.groundId) return;
    let stale = false;
    parties.forEach(async (p) => {
      if (p.touched) return;
      const qs = new URLSearchParams({
        groundId: f.groundId, kind: f.kind, ...(f.slotTemplateId ? { slotTemplateId: f.slotTemplateId } : {}), ...(p.teamId ? { teamId: p.teamId } : {}),
        ...(f.kind === 'event' && f.eventType ? { eventType: f.eventType, ...(f.eventType === 'tournament' && f.matchCount ? { matchCount: String(f.matchCount) } : {}) } : {}),
      });
      try {
        const qt = await api<Quote>(`/pricing/quote?${qs}`);
        if (!stale) setParties((rows) => rows.map((r) => (r.key === p.key && !r.touched ? { ...r, amountDue: qt.price } : r)));
      } catch { /* leave blank */ }
    });
    return () => { stale = true; };
  }, [f.groundId, f.slotTemplateId, f.kind, f.eventType, f.matchCount, priceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const setParty = (key: string, patch: Partial<PartyRow>) => setParties((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  function setKind(kind: BookingKind) {
    if (kind === f.kind) return;
    setF({ ...f, kind });
    // Promoters and teams don't mix: switching to/from a promoter starts the list afresh (keeping paid rows).
    const keep = parties.filter((p) => p.teamName.trim() && (f.kind === 'promoter') === (kind === 'promoter') ? true : p.paid > 0);
    const named = keep.map((p) => ({ ...p, touched: p.id ? p.touched : false }));
    if (kind === 'promoter') setParties([{ ...(named[0] ?? blankParty('client')), side: 'client' }]);
    else if (kind === 'event') setParties(named.length ? named.map((p) => ({ ...p, side: 'client' })) : [blankParty('client')]);
    else setParties([{ ...(named[0] ?? blankParty('A')), side: 'A' }, { ...(named[1] ?? blankParty('B')), side: 'B' }]);
  }

  /** Full day: cover every slot on the ground that day (times stay editable). */
  function setEventType(eventType: EventType) {
    const next = { ...f, eventType };
    if (eventType === 'full_day' && slotOptions.length) {
      next.slotTemplateId = '';
      next.startTime = slotOptions.reduce((m, s) => (s.startTime < m ? s.startTime : m), slotOptions[0].startTime);
      next.endTime = slotOptions.reduce((m, s) => (s.endTime > m ? s.endTime : m), slotOptions[0].endTime);
    }
    setF(next);
  }

  async function save(e?: FormEvent, allowOverlap = false) {
    e?.preventDefault();
    setError(null);
    setClash(false);
    if (!f.groundId) return setError(new Error('Choose a ground'));
    if (!f.startTime || !f.endTime || f.startTime >= f.endTime) return setError(new Error('End time must be after start time'));
    if (f.kind === 'promoter' && !parties[0]?.teamId) return setError(new Error('Choose the promoter'));
    const ambiguous = parties.find((p) => !p.teamId && p.teamName.trim() && !p.newTeam && teamList.some((t) => nameKey(t.name) === nameKey(p.teamName)));
    if (ambiguous) return setError(new Error(`Pick which “${ambiguous.teamName.trim()}” you mean, or mark it as a new team.`));
    setBusy(true);
    const body = {
      groundId: f.groundId, date: f.date, slotTemplateId: f.slotTemplateId || null, startTime: f.startTime, endTime: f.endTime,
      kind: f.kind, title: f.title || null, status: f.status, notes: f.notes || null, allowOverlap,
      eventType: f.kind === 'event' ? f.eventType || null : null,
      matchCount: f.kind === 'event' && f.eventType === 'tournament' ? f.matchCount || 1 : null,
      parties: parties.filter((p) => p.teamName.trim()).map((p) => ({
        ...(p.id ? { id: p.id } : {}), side: p.side,
        ...(p.teamId ? { teamId: p.teamId } : {
          teamName: p.teamName.trim(), ...(p.newTeam ? { newTeam: true } : {}),
          ...(p.contactName?.trim() && p.contactMobile?.trim() ? { contact: { name: p.contactName.trim(), mobile: p.contactMobile.trim() } } : {}),
        }),
        ...(p.amountDue !== '' ? { amountDue: p.amountDue } : {}),
      })),
    };
    try {
      const saved = await api<Booking>(isNew ? '/bookings' : `/bookings/${id}`, { method: isNew ? 'POST' : 'PATCH', body });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['availability'] }), qc.invalidateQueries({ queryKey: ['availability-week'] }),
        qc.invalidateQueries({ queryKey: ['dues'] }), qc.invalidateQueries({ queryKey: ['teams'] }), qc.invalidateQueries({ queryKey: ['report'] }),
        qc.invalidateQueries({ queryKey: ['bookings-day'] }),
      ]);
      qc.setQueryData(['booking', saved.id], saved);
      if (isNew) nav(`/bookings/${saved.id}?saved=1`, { replace: true });
      else { setLoaded(false); await qc.invalidateQueries({ queryKey: ['booking', id] }); nav(`/bookings/${id}?saved=1`, { replace: true }); }
    } catch (err) {
      setError(err);
      if (err instanceof ApiError && err.status === 409 && err.details && typeof err.details === 'object' && 'clashes' in err.details) setClash(true);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    try {
      await api(`/bookings/${id}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['availability'] });
      qc.invalidateQueries({ queryKey: ['availability-week'] });
      qc.invalidateQueries({ queryKey: ['dues'] });
      qc.invalidateQueries({ queryKey: ['bookings-day'] });
      if (fromSlot) nav(`/bookings/new?${new URLSearchParams({ groundId: f.groundId, date: f.date, ...(f.slotTemplateId ? { slot: f.slotTemplateId } : {}) })}`, { replace: true });
      else nav(`/?date=${f.date}`, { replace: true });
    } catch (err) { setError(err); }
  }

  if (!isNew && (existing.isLoading || !loaded)) return <><PageHeader title="Booking" back /><Spinner /></>;
  if (existing.error) return <><PageHeader title="Booking" back /><Page><ErrorNote error={existing.error} /></Page></>;

  const b = existing.data;
  const chosenIds = parties.map((p) => p.teamId).filter(Boolean) as string[];
  const totalDue = parties.reduce((s, p) => s + (p.teamName.trim() ? p.amountDue || 0 : 0), 0);

  return (
    <>
      <PageHeader title={isNew ? 'New booking' : 'Booking'} back action={b && <StatusBadge status={b.status} />} />
      <Page>
        {params.get('saved') && (
          <div className="mb-4 flex items-center justify-between rounded-xl bg-free-bg px-3 py-2.5 text-sm font-semibold text-free">
            ✓ Booking saved
            <Link to={`/?date=${f.date}`} className="underline">Back to slots</Link>
          </div>
        )}

        {fromSlot && b && !params.get('saved') && (
          <div className="mb-4 rounded-xl border border-full/25 bg-full-bg p-3">
            <p className="text-sm font-bold text-full">This slot is already booked</p>
            <p className="mt-0.5 text-sm">{fmtRange(b.startTime, b.endTime)} · {bookingTeams(b)}. The details are filled in below: change them and save, or delete the booking.</p>
            {b.totalPaid > 0 ? (
              <p className="mt-2 text-xs text-muted">It has payments, so it can't be deleted. Set status to Cancel instead.</p>
            ) : confirmDelete ? (
              <div className="mt-2 flex gap-2">
                <Button type="button" size="sm" variant="danger" onClick={remove}>Yes, delete it</Button>
                <Button type="button" size="sm" variant="secondary" onClick={() => setConfirmDelete(false)}>Keep</Button>
              </div>
            ) : (
              <Button type="button" size="sm" variant="danger" className="mt-2" onClick={() => setConfirmDelete(true)}>Delete this booking</Button>
            )}
          </div>
        )}

        <form onSubmit={(e) => save(e)} className="space-y-5">
          <Segmented value={f.kind} onChange={setKind} options={[{ value: 'match', label: '2 teams' }, { value: 'promoter', label: 'Promoter' }, { value: 'event', label: 'Event' }]} />

          <Card className="space-y-4 p-4">
            <Field label="Ground">
              <Select value={f.groundId} onChange={(e) => setF({ ...f, groundId: e.target.value, slotTemplateId: '' })} required>
                <option value="" disabled>Choose a ground</option>
                {grounds.data?.filter((g) => g.active || g.id === f.groundId).map((g) => <option key={g.id} value={g.id}>{g.name} · {g.cityName}</option>)}
              </Select>
            </Field>
            <Field label="Date" hint={fmtLong(f.date)}>
              <Input type="date" value={f.date} onChange={(e) => e.target.value && setF({ ...f, date: e.target.value })} required />
            </Field>
            {slotOptions.length > 0 && (
              <Field label="Slot">
                <div className="flex flex-wrap gap-2">
                  {slotOptions.map((s) => {
                    const taken = bookedFor(s);
                    const sel = f.slotTemplateId === s.id;
                    return (
                      <button type="button" key={s.id} onClick={() => setF({ ...f, slotTemplateId: s.id, startTime: s.startTime, endTime: s.endTime })}
                        className={cx('max-w-[11rem] rounded-xl border px-3 py-2 text-left',
                          sel ? 'border-pitch bg-pitch text-white' : taken ? (bookingState(taken) === 'full' ? 'border-full/30 bg-full-bg' : 'border-partial/30 bg-partial-bg') : 'border-line bg-white')}>
                        <div className="text-sm font-bold">{s.name}</div>
                        <div className={cx('text-xs tabular', sel ? 'text-white/75' : 'text-muted')}>{fmtRange(s.startTime, s.endTime)}</div>
                        {taken && <div className={cx('truncate text-[11px] font-semibold', sel ? 'text-white' : bookingState(taken) === 'full' ? 'text-full' : 'text-partial')}>Booked: {bookingTeams(taken)}</div>}
                      </button>
                    );
                  })}
                  <button type="button" onClick={() => setF({ ...f, slotTemplateId: '' })}
                    className={cx('rounded-xl border px-3 py-2 text-sm font-bold', !f.slotTemplateId ? 'border-pitch bg-pitch text-white' : 'border-line bg-white')}>Custom</button>
                </div>
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start"><Input type="time" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} required /></Field>
              <Field label="End"><Input type="time" value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} required /></Field>
            </div>
            {slot && (f.startTime !== slot.startTime || f.endTime !== slot.endTime) && (
              <p className="-mt-2 text-xs text-muted">Times differ from the {slot.name} slot; the calendar will show {fmtRange(f.startTime || slot.startTime, f.endTime || slot.endTime)}.</p>
            )}
            {overlapping.length > 0 && (
              <BookedBanner bookings={overlapping} onOpen={(bk) => nav(`/bookings/${bk.id}?existing=1`, { replace: isNew })} onDelete={deleteOther} />
            )}
            {f.kind === 'event' && (
              <>
                <Field label="Event type" hint={f.eventType === 'full_day' ? 'Times set to cover the whole day; change them if needed.' : f.eventType === 'tournament' ? 'Priced per match' : undefined}>
                  <Segmented value={f.eventType || ('' as EventType)} onChange={setEventType}
                    options={(Object.keys(EVENT_LABEL) as EventType[]).map((t) => ({ value: t, label: EVENT_LABEL[t] }))} />
                </Field>
                {f.eventType === 'tournament' && (
                  <Field label="Number of matches">
                    <Input inputMode="numeric" className="tabular" value={f.matchCount}
                      onChange={(e) => { const d = e.target.value.replace(/\D/g, ''); setF({ ...f, matchCount: d === '' ? '' : Math.min(500, Number(d)) }); }} />
                  </Field>
                )}
                <Field label="Event name"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Corporate tournament" /></Field>
              </>
            )}
          </Card>

          {f.kind === 'promoter' ? (
            <PromoterSection row={parties[0] ?? blankParty('client')} promoters={promoters.data ?? []}
              onPick={(t) => setParties([{ ...(parties[0] ?? blankParty('client')), side: 'client', teamId: t.id, teamName: t.name, pocName: t.poc?.name, pocMobile: t.poc?.mobile, touched: false, amountDue: '' }])}
              onAmount={(v) => setParty(parties[0].key, { amountDue: v, touched: true })}
              onDefault={() => setParty(parties[0].key, { touched: false })}
              onPay={() => setPayFor(parties[0])} />
          ) : (
          <section>
            <h3 className="mb-2 px-1 text-xs font-bold uppercase tracking-wide text-muted">{f.kind === 'match' ? 'Teams · price per team' : 'Clients · price per client'}</h3>
            <div className="space-y-3">
              {parties.map((p, i) => {
                const team = teamList.find((t) => t.id === p.teamId);
                return (
                  <Card key={p.key} className="space-y-3 p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-bold">{f.kind === 'match' ? `Team ${p.side}` : `Client ${i + 1}`}</span>
                      {f.kind === 'event' && parties.length > 1 && !p.paid && (
                        <button type="button" className="text-xs font-semibold text-full" onClick={() => setParties(parties.filter((r) => r.key !== p.key))}>Remove</button>
                      )}
                      {f.kind === 'match' && p.teamName && !p.paid && (
                        <button type="button" className="text-xs font-semibold text-muted" onClick={() => setParty(p.key, { teamId: undefined, teamName: '', touched: false, amountDue: '' })}>Clear</button>
                      )}
                    </div>
                    <TeamPicker value={{ teamId: p.teamId, teamName: p.teamName, newTeam: p.newTeam, contactName: p.contactName, contactMobile: p.contactMobile }}
                      teams={teamList.some((t) => t.id === p.teamId) || !p.teamId ? teamList : [...teamList, { id: p.teamId, name: p.teamName, notes: null, active: false, bookingCount: 0, contacts: [], poc: p.pocName ? { contactId: '', name: p.pocName, mobile: p.pocMobile ?? '' } : null }]}
                      exclude={chosenIds.filter((x) => x !== p.teamId)}
                      placeholder={f.kind === 'match' ? 'Optional — leave empty if not known yet' : 'Client / team name'}
                      onChange={(v: TeamRef) => setParty(p.key, { teamId: v.teamId, teamName: v.teamName, newTeam: v.newTeam, contactName: v.contactName, contactMobile: v.contactMobile })} />
                    {p.teamName.trim() && (
                      <div className="flex items-end gap-3">
                        <Field label="Amount for this team" className="flex-1">
                          <MoneyInput value={p.amountDue} onChange={(v) => setParty(p.key, { amountDue: v, touched: true })} />
                        </Field>
                        {p.touched && !p.id && (
                          <button type="button" className="mb-3 text-xs font-semibold text-pitch" onClick={() => setParty(p.key, { touched: false })}>Use default</button>
                        )}
                      </div>
                    )}
                    {team && !team.poc && (
                      <Link to={`/admin/teams/${team.id}`} className="block text-xs font-semibold text-partial">⚠ No contact for {team.name}. Add one for reminders ›</Link>
                    )}
                    {p.id && (
                      <PartyMoney party={p} onPay={() => setPayFor(p)} />
                    )}
                  </Card>
                );
              })}
              {f.kind === 'event' && (
                <Button type="button" variant="secondary" className="w-full" onClick={() => setParties([...parties, blankParty('client')])}>+ Add another client</Button>
              )}
            </div>
          </section>
          )}

          {!isNew && (
            <Field label="Status" hint={f.status === 'partial' ? 'Match not completed. Adjust each team’s amount above.' : f.status === 'cancelled' ? 'Set any cancellation charge in the amounts above (0 = no charge). The slot becomes free.' : undefined}>
              <Segmented value={f.status} onChange={(s) => setF({ ...f, status: s })} options={[
                { value: 'confirmed', label: 'Upcoming' }, { value: 'completed', label: 'Played' },
                { value: 'partial', label: 'Part' }, { value: 'cancelled', label: 'Cancel' },
              ]} />
            </Field>
          )}

          <Field label="Notes"><Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Anything to remember" /></Field>

          <ErrorNote error={error} />
          {clash && (
            <Button type="button" variant="danger" className="w-full" onClick={() => save(undefined, true)}>Save anyway (double-book)</Button>
          )}

          <div className="pb-safe sticky bottom-16 z-10 -mx-4 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur">
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <div className="text-xs font-semibold text-muted">Total</div>
                <div className="text-lg font-bold tabular">{inr(totalDue)}</div>
              </div>
              <Button disabled={busy} className="min-w-36">{busy ? 'Saving…' : isNew ? 'Book' : 'Save changes'}</Button>
            </div>
          </div>
        </form>

        {b?.payments && b.payments.length > 0 && (
          <PaymentHistory booking={b} onChanged={() => { qc.invalidateQueries({ queryKey: ['booking', id] }); qc.invalidateQueries({ queryKey: ['dues'] }); }} />
        )}

        {!isNew && b && b.totalPaid === 0 && (
          <div className="mt-8">
            {confirmDelete ? (
              <div className="flex gap-2">
                <Button variant="danger" className="flex-1" onClick={remove}>Yes, delete it</Button>
                <Button variant="secondary" className="flex-1" onClick={() => setConfirmDelete(false)}>Keep</Button>
              </div>
            ) : (
              <Button variant="danger" className="w-full" onClick={() => setConfirmDelete(true)}>Delete booking</Button>
            )}
            <p className="mt-1 text-center text-xs text-muted">To keep a record, set status to Cancel instead.</p>
          </div>
        )}
      </Page>

      {payFor && b && (
        <PaymentSheet bookingId={b.id} party={payFor} onClose={() => setPayFor(null)} onSaved={() => {
          setPayFor(null);
          qc.invalidateQueries({ queryKey: ['booking', id] });
          qc.invalidateQueries({ queryKey: ['dues'] });
          qc.invalidateQueries({ queryKey: ['availability'] });
          qc.invalidateQueries({ queryKey: ['report'] });
        }} />
      )}
    </>
  );
}

function PartyMoney({ party, onPay }: { party: PartyRow; onPay: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-paper px-3 py-2">
      <div className="flex-1 text-sm tabular">
        <span className="text-muted">Paid </span><span className="font-semibold">{inr(party.paid)}</span>
        <span className="text-muted"> · Balance </span>
        <span className={cx('font-bold', party.balance > 0 ? 'text-full' : 'text-free')}>{party.balance > 0 ? inr(party.balance) : party.balance < 0 ? `${inr(-party.balance)} extra` : 'Settled'}</span>
      </div>
      <Button type="button" size="sm" variant={party.balance > 0 ? 'primary' : 'secondary'} onClick={onPay}>+ Payment</Button>
    </div>
  );
}

function PaymentSheet({ bookingId, party, onClose, onSaved }: { bookingId: string; party: PartyRow; onClose: () => void; onSaved: () => void }) {
  const [amount, setAmount] = useState<number | ''>(party.balance > 0 ? party.balance : '');
  const [method, setMethod] = useState<Payment['method']>('upi');
  const accounts = useAccounts();
  const live = (accounts.data ?? []).filter((a) => a.active);
  const [accountId, setAccountId] = useState<string | null>(null);
  const chosen = accountId ?? live.find((a) => a.isDefault)?.id ?? live[0]?.id ?? null;
  const [paidOn, setPaidOn] = useState(todayISO());
  const [reference, setReference] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!amount) return setError(new Error('Enter an amount'));
    setBusy(true);
    try {
      await api(`/bookings/${bookingId}/payments`, { body: { bookingPartyId: party.id, amount, method, paidOn, reference: reference || null, accountId: method === 'cash' ? null : chosen } });
      onSaved();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return (
    <Sheet open onClose={onClose} title={`Payment · ${party.teamName}`}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">Balance due: <b className="text-ink">{inr(party.balance)}</b></p>
        <Field label="Amount received"><MoneyInput value={amount} onChange={setAmount} autoFocus /></Field>
        <Field label="Method">
          <Segmented value={method} onChange={setMethod} options={[{ value: 'upi', label: 'UPI' }, { value: 'cash', label: 'Cash' }, { value: 'bank', label: 'Bank' }, { value: 'other', label: 'Other' }]} />
        </Field>
        {method !== 'cash' && live.length > 0 && (
          <Field label="Received in">
            <div className="flex flex-wrap gap-2">
              {live.map((a) => <Chip key={a.id} active={a.id === chosen} onClick={() => setAccountId(a.id)}>{a.name}</Chip>)}
            </div>
          </Field>
        )}
        <Field label="Date received"><Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></Field>
        <Field label="Reference (optional)"><Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UPI ref / note" /></Field>
        <ErrorNote error={error} />
        <Button className="w-full" disabled={busy}>{busy ? 'Saving…' : 'Record payment'}</Button>
      </form>
    </Sheet>
  );
}

function PaymentHistory({ booking, onChanged }: { booking: Booking; onChanged: () => void }) {
  const [armed, setArmed] = useState<string | null>(null);
  const teamOf = (partyId: string) => booking.parties.find((p) => p.id === partyId)?.teamName ?? '';
  const accounts = useAccounts();
  const acctName = (id: string | null) => (id ? accounts.data?.find((a) => a.id === id)?.name : undefined);
  async function del(pid: string) {
    await api(`/bookings/payments/${pid}`, { method: 'DELETE' });
    setArmed(null);
    onChanged();
  }
  return (
    <section className="mt-8">
      <h3 className="mb-2 px-1 text-xs font-bold uppercase tracking-wide text-muted">Payments received</h3>
      <Card className="divide-y divide-line">
        {booking.payments!.map((p) => (
          <div key={p.id} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{inr(p.amount)} <span className="text-sm font-medium text-muted">· {teamOf(p.bookingPartyId)}</span></div>
              <div className="text-xs text-muted">{fmtDate(p.paidOn)} · {p.method.toUpperCase()}{acctName(p.accountId) ? ` → ${acctName(p.accountId)}` : ''}{p.reference ? ` · ${p.reference}` : ''}</div>
            </div>
            {armed === p.id
              ? <Button size="sm" variant="danger" onClick={() => del(p.id)}>Delete?</Button>
              : <button className="px-2 text-muted" aria-label="Delete payment" onClick={() => setArmed(p.id)}>✕</button>}
          </div>
        ))}
      </Card>
    </section>
  );
}

const bookingState = (b: Booking) => (b.kind !== 'match' || b.parties.filter((p) => p.side !== 'client').length >= 2 ? 'full' : 'partial');
/** "Goru vs ?" / event title, for showing what's in a slot. */
function bookingTeams(b: Booking): string {
  if (b.kind === 'event') return b.title || b.parties.map((p) => p.teamName).join(', ') || 'Event';
  if (b.kind === 'promoter') return `${b.parties[0]?.teamName ?? '?'} (promoter)`;
  const a = b.parties.find((p) => p.side === 'A')?.teamName, c = b.parties.find((p) => p.side === 'B')?.teamName;
  return `${a ?? '?'} vs ${c ?? '?'}`;
}

/** Shown as soon as the chosen times overlap an existing booking. */
function BookedBanner({ bookings, onOpen, onDelete }: { bookings: Booking[]; onOpen: (b: Booking) => void; onDelete: (b: Booking) => Promise<void> }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <div className="space-y-2 rounded-xl border border-full/25 bg-full-bg p-3">
      <p className="text-sm font-bold text-full">Already booked at this time</p>
      {bookings.map((bk) => (
        <div key={bk.id} className="rounded-lg bg-white/70 p-2.5">
          <div className="text-sm"><span className="font-semibold tabular">{fmtRange(bk.startTime, bk.endTime)}</span> · {bookingTeams(bk)}</div>
          {bk.parties.some((p) => p.pocName) && (
            <div className="text-xs text-muted">{bk.parties.filter((p) => p.pocName).map((p) => `${p.teamName}: ${p.pocName}`).join(' · ')}</div>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => onOpen(bk)}>Edit this booking</Button>
            {bk.totalPaid > 0 ? (
              <span className="self-center text-xs text-muted">Has payments: open it to cancel</span>
            ) : confirm === bk.id ? (
              <>
                <Button type="button" size="sm" variant="danger" onClick={async () => { await onDelete(bk); setConfirm(null); }}>Yes, delete</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(null)}>Keep</Button>
              </>
            ) : (
              <Button type="button" size="sm" variant="danger" onClick={() => setConfirm(bk.id)}>Delete</Button>
            )}
          </div>
        </div>
      ))}
      <p className="text-xs text-muted">Or change the slot or times above. You can still double-book with Book.</p>
    </div>
  );
}

/** A promoter takes the whole slot at their own rate. Promoters are added in More → Promoters. */
function PromoterSection({ row, promoters, onPick, onAmount, onDefault, onPay }: {
  row: PartyRow; promoters: Team[]; onPick: (t: Team) => void; onAmount: (v: number | '') => void; onDefault: () => void; onPay: () => void;
}) {
  const list = promoters.some((t) => t.id === row.teamId) || !row.teamId ? promoters
    : [...promoters, { id: row.teamId, name: row.teamName, notes: null, active: false, bookingCount: 0, contacts: [], poc: row.pocName ? { contactId: '', name: row.pocName, mobile: row.pocMobile ?? '' } : null }];
  return (
    <section>
      <h3 className="mb-2 px-1 text-xs font-bold uppercase tracking-wide text-muted">Promoter · price for the whole slot</h3>
      <Card className="space-y-3 p-4">
        {!list.length ? (
          <p className="text-sm text-muted">No promoters yet. <Link to="/admin/promoters" className="font-semibold text-pitch">Add one ›</Link></p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {list.map((t) => {
              const sel = t.id === row.teamId;
              return (
                <button type="button" key={t.id} disabled={row.paid > 0 && !sel} onClick={() => onPick(t)}
                  className={cx('rounded-xl border px-3 py-2.5 text-left disabled:opacity-40', sel ? 'border-pitch bg-pitch text-white' : 'border-line bg-white')}>
                  <div className="font-bold">{t.name}</div>
                  <div className={cx('truncate text-xs', sel ? 'text-white/75' : 'text-muted')}>
                    {pocLine(t.poc?.name, t.poc?.mobile)}{t.defaultRate != null ? ` · ${inr(t.defaultRate)}/slot` : ''}
                  </div>
                </button>
              );
            })}
          </div>
        )}
        {row.teamId && (
          <div className="flex items-end gap-3">
            <Field label="Amount for the slot" className="flex-1"><MoneyInput value={row.amountDue} onChange={onAmount} /></Field>
            {row.touched && !row.id && <button type="button" className="mb-3 text-xs font-semibold text-pitch" onClick={onDefault}>Use promoter rate</button>}
          </div>
        )}
        {row.id && <PartyMoney party={row} onPay={onPay} />}
      </Card>
    </section>
  );
}
