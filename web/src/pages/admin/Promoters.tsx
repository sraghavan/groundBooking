import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type Team } from '../../api';
import { usePromoters } from '../../hooks';
import { fmtMobile } from '../../lib';
import { Button, Card, ErrorNote, Input, MoneyInput, Page, PageHeader, Spinner } from '../../components/ui';

/**
 * Promoters (e.g. Rana, Ravinder) take whole slots. Each has standard rates,
 * the same at every ground: per match (a slot), half-day and full-day event.
 * Edited in place, one row per promoter.
 */
type Row = {
  key: string; id?: string;
  name: string; mobile: string;
  match: number | ''; half: number | ''; full: number | '';
};

const toRow = (t: Team): Row => ({
  key: t.id, id: t.id, name: t.name, mobile: fmtMobile(t.poc?.mobile ?? ''),
  match: t.defaultRate ?? '', half: t.rateHalfDay ?? '', full: t.rateFullDay ?? '',
});
const blank = (): Row => ({ key: crypto.randomUUID(), name: '', mobile: '', match: '', half: '', full: '' });
const same = (a: Row, b: Row) => a.name === b.name && a.mobile === b.mobile && a.match === b.match && a.half === b.half && a.full === b.full;
const n = (v: number | '') => (v === '' ? null : v);

const cols = 'sm:grid-cols-[1.3fr_1.2fr_1fr_1fr_1fr_5.5rem]';

export function PromotersPage() {
  const promoters = usePromoters();
  const [added, setAdded] = useState<Row[]>([]);
  const saved = [...(promoters.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <PageHeader title="Promoters" back="/more" action={<Button size="sm" onClick={() => setAdded((r) => [...r, blank()])}>+ Add</Button>} />
      <Page className="max-w-4xl space-y-3">
        <p className="text-sm text-muted">Standard rates, the same at every ground. They're filled in when you book a slot or event for a promoter, and can be changed on the booking.</p>
        <div className={`hidden gap-2 px-3 text-xs font-semibold uppercase tracking-wide text-muted sm:grid ${cols}`}>
          <span>Name</span><span>Mobile</span><span>Rate / match</span><span>Half day</span><span>Full day</span><span />
        </div>
        {promoters.isLoading ? <Spinner /> : (
          <>
            {saved.map((t) => <PromoterRow key={t.id} initial={toRow(t)} />)}
            {added.map((r) => (
              <PromoterRow key={r.key} initial={r} onDiscard={() => setAdded((rows) => rows.filter((x) => x.key !== r.key))}
                onCreated={() => setAdded((rows) => rows.filter((x) => x.key !== r.key))} />
            ))}
            {!saved.length && !added.length && <p className="px-1 text-sm text-muted">No promoters yet. Tap + Add.</p>}
          </>
        )}
      </Page>
    </>
  );
}

function PromoterRow({ initial, onDiscard, onCreated }: { initial: Row; onDiscard?: () => void; onCreated?: () => void }) {
  const qc = useQueryClient();
  const [r, setR] = useState(initial);
  const [base, setBase] = useState(initial);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const isNew = !r.id;
  const dirty = isNew || !same(r, base);
  const set = (patch: Partial<Row>) => { setR({ ...r, ...patch }); setArmed(false); };
  const refresh = () => Promise.all(['promoters', 'dues', 'teams'].map((k) => qc.invalidateQueries({ queryKey: [k] })));

  async function save() {
    if (!r.name.trim()) return setError(new Error('Enter a name'));
    setBusy(true);
    setError(null);
    const rates = { defaultRate: n(r.match), rateHalfDay: n(r.half), rateFullDay: n(r.full) };
    try {
      if (isNew) {
        await api('/teams', { body: { name: r.name.trim(), kind: 'promoter', allowDuplicateName: true, ...rates,
          contacts: r.mobile.trim() ? [{ name: r.name.trim(), mobile: r.mobile }] : [] } });
        await refresh();
        onCreated?.();
      } else {
        await api(`/teams/${r.id}`, { method: 'PATCH', body: { name: r.name.trim(), ...rates, ...(r.mobile !== base.mobile ? { mobile: r.mobile.trim() || null } : {}) } });
        setBase(r);
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error && /mobile/i.test(err.message) ? new Error('Enter a valid mobile number') : err);
    } finally { setBusy(false); }
  }

  /** Removes the promoter. One with bookings is archived instead, so its history and dues stay. */
  async function remove() {
    if (isNew) return onDiscard?.();
    setBusy(true);
    try {
      await api(`/teams/${r.id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) { setError(err); setBusy(false); }
  }

  const small = '!h-10';
  return (
    <Card className="p-3">
      <div className={`grid grid-cols-2 gap-2 sm:items-center ${cols}`}>
        <Cell label="Name"><Input className={small} value={r.name} autoFocus={isNew} placeholder="Name" onChange={(e) => set({ name: e.target.value })} /></Cell>
        <Cell label="Mobile"><Input className={small} inputMode="tel" value={r.mobile} placeholder="98xxxxxxxx" onChange={(e) => set({ mobile: e.target.value })} /></Cell>
        <Cell label="Rate / match"><MoneyInput className="[&_input]:!h-10" value={r.match} onChange={(v) => set({ match: v })} /></Cell>
        <Cell label="Half day"><MoneyInput className="[&_input]:!h-10" value={r.half} onChange={(v) => set({ half: v })} /></Cell>
        <Cell label="Full day"><MoneyInput className="[&_input]:!h-10" value={r.full} onChange={(v) => set({ full: v })} /></Cell>
        <div className="col-span-2 flex justify-end gap-1.5 sm:col-span-1">
          {dirty && <Button size="sm" disabled={busy} onClick={save}>{busy ? '…' : 'Save'}</Button>}
          {armed
            ? <Button size="sm" variant="danger" disabled={busy} onClick={remove}>Delete?</Button>
            : <button type="button" aria-label={`Delete ${r.name || 'row'}`} className="grid h-9 w-9 place-items-center rounded-xl text-muted active:bg-paper"
                onClick={() => (isNew ? onDiscard?.() : setArmed(true))}>✕</button>}
        </div>
      </div>
      {armed && <p className="mt-2 text-xs text-muted">Past bookings and dues are kept; the promoter just won't be offered for new bookings.</p>}
      {error != null && <div className="mt-2"><ErrorNote error={error} /></div>}
    </Card>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-muted sm:hidden">{label}</span>
      {children}
    </label>
  );
}
