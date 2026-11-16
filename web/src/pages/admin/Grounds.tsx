import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Ground, type SlotTemplate, type StandardSlot } from '../../api';
import { useCities, useGrounds, useMe } from '../../hooks';
import { cx, fmtRange, inr } from '../../lib';
import { Button, Card, ConfirmSheet, Empty, ErrorNote, Field, Input, ListLink, MoneyInput, Page, PageHeader, Spinner, Textarea } from '../../components/ui';

const useStandardSlots = () => useQuery({ queryKey: ['standard-slots'], queryFn: () => api<StandardSlot[]>('/grounds/standard-slots') });

export function GroundsAdminPage() {
  const grounds = useGrounds();
  const byCity = new Map<string, Ground[]>();
  grounds.data?.forEach((g) => byCity.set(g.cityName, [...(byCity.get(g.cityName) ?? []), g]));
  return (
    <>
      <PageHeader title="Grounds" back="/more" action={<Link to="/admin/grounds/new" className="rounded-full bg-pitch px-4 py-2 text-sm font-semibold text-white">+ Add</Link>} />
      <Page className="space-y-5">
        <StandardSlotsCard />
        {grounds.isLoading ? <Spinner /> : !grounds.data?.length ? <Empty title="No grounds yet"><Link to="/admin/grounds/new" className="font-semibold text-pitch underline">Add a ground</Link></Empty> : (
          [...byCity.entries()].map(([city, gs]) => (
            <section key={city}>
              <h3 className="mb-2 px-1 text-xs font-bold uppercase tracking-wide text-muted">{city}</h3>
              <Card className="divide-y divide-line overflow-hidden">
                {gs.map((g) => (
                  <ListLink key={g.id} to={`/admin/grounds/${g.id}`}
                    title={<span className={cx(!g.active && 'text-muted line-through')}>{g.name}</span>}
                    sub={g.slots.some((s) => s.active) ? g.slots.filter((s) => s.active).map((s) => `${s.name} ${fmtRange(s.startTime, s.endTime)}`).join(' · ') : 'No slots yet'}
                    right={g.defaultPrice != null && <span className="text-sm text-muted tabular">{inr(g.defaultPrice)}</span>} />
                ))}
              </Card>
            </section>
          ))
        )}
      </Page>
    </>
  );
}

type SlotRow = { key: string; id?: string; name: string; startTime: string; endTime: string; defaultPrice: number | ''; daysOfWeek: number[] };
const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const toRow = (s: SlotTemplate): SlotRow => ({ key: s.id, id: s.id, name: s.name, startTime: s.startTime, endTime: s.endTime, defaultPrice: s.defaultPrice ?? '', daysOfWeek: s.daysOfWeek });
const newRow = (name = '', startTime = '', endTime = ''): SlotRow => ({ key: crypto.randomUUID(), name, startTime, endTime, defaultPrice: '', daysOfWeek: ALL_DAYS });

export function GroundEditPage() {
  const { id } = useParams();
  const isNew = id === 'new';
  const nav = useNavigate();
  const qc = useQueryClient();
  const grounds = useGrounds();
  const cities = useCities();
  const ground = grounds.data?.find((g) => g.id === id);

  const [f, setF] = useState({ name: '', cityName: '', defaultPrice: '' as number | '', address: '', notes: '', active: true });
  const std = useStandardSlots();
  const [slots, setSlots] = useState<SlotRow[]>([]);
  // A new ground starts with the standard slots.
  useEffect(() => { if (isNew && std.data) setSlots(std.data.map((s) => newRow(s.name, s.startTime, s.endTime))); }, [isNew, std.data]);
  const [loaded, setLoaded] = useState(isNew);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (loaded || !ground) return;
    setF({ name: ground.name, cityName: ground.cityName, defaultPrice: ground.defaultPrice ?? '', address: ground.address ?? '', notes: ground.notes ?? '', active: ground.active });
    setSlots(ground.slots.filter((s) => s.active).map(toRow)); // switched-off slots stay hidden (their bookings keep their times)
    setLoaded(true);
  }, [ground, loaded]);

  const setSlot = (key: string, patch: Partial<SlotRow>) => setSlots((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const slotPayload = (s: SlotRow, i: number) => ({ name: s.name.trim(), startTime: s.startTime, endTime: s.endTime, defaultPrice: s.defaultPrice === '' ? null : s.defaultPrice, daysOfWeek: s.daysOfWeek, sortOrder: i });

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const bad = slots.find((s) => !s.name.trim() || !s.startTime || !s.endTime || s.startTime >= s.endTime || !s.daysOfWeek.length);
    if (bad) return setError(new Error(`Check slot "${bad.name || 'unnamed'}": it needs a name, an end after the start, and at least one day`));
    setBusy(true);
    try {
      const city = cities.data?.find((c) => c.name.toLowerCase() === f.cityName.trim().toLowerCase());
      const base = {
        name: f.name.trim(), defaultPrice: f.defaultPrice === '' ? null : f.defaultPrice,
        address: f.address || null, notes: f.notes || null,
      };
      if (isNew) {
        await api('/grounds', { body: { ...base, ...(city ? { cityId: city.id } : { cityName: f.cityName.trim() }), slots: slots.map(slotPayload) } });
      } else {
        let cityId = city?.id;
        if (!cityId) cityId = (await api<{ id: string }>('/cities', { body: { name: f.cityName.trim() } })).id;
        await api(`/grounds/${id}`, { method: 'PATCH', body: { ...base, cityId, active: f.active } });
        const keep = new Set(slots.map((s) => s.id).filter(Boolean));
        for (const s of ground!.slots) if (s.active && !keep.has(s.id)) await api(`/grounds/slots/${s.id}`, { method: 'PATCH', body: { active: false } });
        for (const [i, s] of slots.entries()) {
          if (s.id) await api(`/grounds/slots/${s.id}`, { method: 'PATCH', body: slotPayload(s, i) });
          else await api(`/grounds/${id}/slots`, { body: slotPayload(s, i) });
        }
      }
      await Promise.all(['grounds', 'cities', 'availability'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      nav('/admin/grounds');
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  if (!isNew && !loaded) return <><PageHeader title="Ground" back="/admin/grounds" />{grounds.isLoading ? <Spinner /> : <Page><Empty title="Ground not found" /></Page>}</>;

  return (
    <>
      <PageHeader title={isNew ? 'New ground' : f.name || 'Ground'} back="/admin/grounds" />
      <Page>
        <form onSubmit={save} className="space-y-5">
          <Card className="space-y-4 p-4">
            <Field label="Ground name"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Green Park Oval" /></Field>
            <Field label="City" hint="Pick one or type a new city">
              <Input required list="city-list" value={f.cityName} onChange={(e) => setF({ ...f, cityName: e.target.value })} placeholder="e.g. Chennai" />
              <datalist id="city-list">{cities.data?.map((c) => <option key={c.id} value={c.name} />)}</datalist>
            </Field>
            <Field label="Default price per team" hint="Used when a slot has no price of its own">
              <MoneyInput value={f.defaultPrice} onChange={(v) => setF({ ...f, defaultPrice: v })} placeholder="0" />
            </Field>
            <Field label="Address / map link"><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
            <Field label="Notes"><Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
            {!isNew && (
              <label className="flex items-center gap-3 text-sm font-semibold">
                <input type="checkbox" className="h-5 w-5 accent-pitch" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
                Active (show on the slots screen)
              </label>
            )}
          </Card>

          <section>
            <div className="mb-2 flex items-end justify-between px-1">
              <h3 className="text-xs font-bold uppercase tracking-wide text-muted">Default slots</h3>
              <span className="text-xs text-muted">Times can still be changed per booking</span>
            </div>
            <div className="space-y-3">
              {slots.map((s) => (
                <Card key={s.key} className="space-y-3 p-4">
                  <div className="flex gap-3">
                    <Field label="Name" className="flex-1"><Input value={s.name} onChange={(e) => setSlot(s.key, { name: e.target.value })} placeholder="Morning" /></Field>
                    <button type="button" className="mt-5 self-center px-2 text-sm font-semibold text-full" onClick={() => setSlots(slots.filter((r) => r.key !== s.key))}>Remove</button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <Field label="Start"><Input type="time" value={s.startTime} onChange={(e) => setSlot(s.key, { startTime: e.target.value })} /></Field>
                    <Field label="End"><Input type="time" value={s.endTime === '24:00' ? '00:00' : s.endTime} onChange={(e) => setSlot(s.key, { endTime: e.target.value === '00:00' ? '24:00' : e.target.value })} /></Field>
                    <Field label="₹ / team"><MoneyInput value={s.defaultPrice} onChange={(v) => setSlot(s.key, { defaultPrice: v })} placeholder={f.defaultPrice === '' ? '–' : String(f.defaultPrice)} /></Field>
                  </div>
                  <div className="flex gap-1.5">
                    {DAYS.map((d, i) => {
                      const on = s.daysOfWeek.includes(i);
                      return (
                        <button type="button" key={i} aria-pressed={on} aria-label={['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]}
                          onClick={() => setSlot(s.key, { daysOfWeek: on ? s.daysOfWeek.filter((x) => x !== i) : [...s.daysOfWeek, i].sort() })}
                          className={cx('h-9 flex-1 rounded-lg text-sm font-bold', on ? 'bg-pitch text-white' : 'bg-line/60 text-muted')}>{d}</button>
                      );
                    })}
                  </div>
                </Card>
              ))}
              <Button type="button" variant="secondary" className="w-full" onClick={() => setSlots([...slots, newRow()])}>+ Add slot</Button>
            </div>
          </section>

          <ErrorNote error={error} />
          <Button className="w-full" disabled={busy}>{busy ? 'Saving…' : 'Save ground'}</Button>
        </form>
      </Page>
    </>
  );
}

/** The standard slot timings every ground uses, with "apply to all grounds". */
function StandardSlotsCard() {
  const me = useMe();
  const owner = me.data?.user.role === 'owner';
  const qc = useQueryClient();
  const std = useStandardSlots();
  const [rows, setRows] = useState<(StandardSlot & { key: string })[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [msg, setMsg] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (std.data) setRows(std.data.map((s) => ({ ...s, key: crypto.randomUUID() }))); }, [std.data]);
  const set = (key: string, patch: Partial<StandardSlot>) => { setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x))); setMsg(''); };
  const dirty = JSON.stringify(rows.map(({ key: _k, ...s }) => s)) !== JSON.stringify(std.data ?? []);

  async function save(): Promise<boolean> {
    setError(null);
    const bad = rows.find((s) => !s.name.trim() || !s.startTime || !s.endTime || s.startTime >= s.endTime);
    if (bad) { setError(new Error(`Check “${bad.name || 'unnamed'}”: it needs a name and an end after the start`)); return false; }
    try {
      await api('/settings', { method: 'PATCH', body: { settings: { standardSlots: rows.map(({ key: _k, ...s }) => ({ ...s, name: s.name.trim() })) } } });
      await Promise.all([qc.invalidateQueries({ queryKey: ['standard-slots'] }), qc.invalidateQueries({ queryKey: ['me'] })]);
      setMsg('✓ Saved');
      return true;
    } catch (err) { setError(err); return false; }
  }

  async function apply() {
    setConfirm(false);
    setBusy(true);
    try {
      if (dirty && !(await save())) return;
      const r = await api<{ grounds: number; added: number; switchedOff: number }>('/grounds/standard-slots/apply', { body: {} });
      await Promise.all(['grounds', 'availability', 'availability-week', 'availability-range'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      setMsg(`✓ Applied to ${r.grounds} grounds${r.switchedOff ? ` · ${r.switchedOff} other slot${r.switchedOff > 1 ? 's' : ''} switched off` : ''}`);
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h3 className="font-bold">Standard slots</h3>
        <p className="text-xs text-muted">Used by every ground, all days. New grounds start with these. Booking times can still be changed per booking.</p>
      </div>
      {std.isLoading ? <Spinner /> : (
        <div className="space-y-2">
          {rows.map((s) => (
            <div key={s.key} className="grid grid-cols-[minmax(0,1fr)_6.5rem_6.5rem_2rem] items-center gap-2">
              <Input className="!h-10" disabled={!owner} value={s.name} onChange={(e) => set(s.key, { name: e.target.value })} aria-label="Slot name" />
              <Input className="!h-10 px-2" disabled={!owner} type="time" value={s.startTime === '24:00' ? '00:00' : s.startTime} onChange={(e) => set(s.key, { startTime: e.target.value })} aria-label="Start" />
              <Input className="!h-10 px-2" disabled={!owner} type="time" value={s.endTime === '24:00' ? '00:00' : s.endTime} onChange={(e) => set(s.key, { endTime: e.target.value === '00:00' ? '24:00' : e.target.value })} aria-label="End" />
              {owner && <button type="button" aria-label={`Remove ${s.name}`} className="text-muted" onClick={() => setRows(rows.filter((x) => x.key !== s.key))}>✕</button>}
            </div>
          ))}
          {owner && <button type="button" className="text-sm font-semibold text-pitch" onClick={() => setRows([...rows, { key: crypto.randomUUID(), name: '', startTime: '', endTime: '' }])}>+ Add slot</button>}
        </div>
      )}
      <ErrorNote error={error} />
      {owner ? (
        <div className="flex flex-wrap items-center gap-2">
          {dirty && <Button size="sm" variant="secondary" onClick={save}>Save</Button>}
          <Button size="sm" disabled={busy} onClick={() => setConfirm(true)}>{busy ? 'Applying…' : 'Apply to all grounds'}</Button>
          {msg && <span className="text-sm font-semibold text-free">{msg}</span>}
        </div>
      ) : <p className="text-xs text-muted">Only the owner can change these.</p>}
      {confirm && (
        <ConfirmSheet title="Apply standard slots?" confirmLabel="Yes, apply to all" onCancel={() => setConfirm(false)} onConfirm={apply}>
          <p>Every ground will get these {rows.length} slots, on all days. A ground's slot with the same name or times is updated in place.</p>
          <p className="mt-2">Other slots are switched off, not deleted: past bookings keep their times.</p>
        </ConfirmSheet>
      )}
    </Card>
  );
}
