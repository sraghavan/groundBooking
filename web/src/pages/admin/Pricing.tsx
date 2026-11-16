import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, DEFAULT_TOURNAMENT_PER_MATCH, type PriceRule } from '../../api';
import { useGrounds, useMe, useTeams } from '../../hooks';
import { inr } from '../../lib';
import { Button, Card, Empty, ErrorNote, Field, MoneyInput, Page, PageHeader, Select, Sheet, Spinner } from '../../components/ui';

/**
 * Special prices. The booking screen pre-fills each team's amount with the most
 * specific match: team+slot, team+ground, team, slot, ground default.
 */
export function PricingPage() {
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ['price-rules'], queryFn: () => api<PriceRule[]>('/pricing/rules') });
  const [editing, setEditing] = useState<PriceRule | 'new' | null>(null);
  const describe = (r: PriceRule) => [r.teamName ? `${r.teamName}${r.teamKind === 'promoter' ? ' (promoter, whole slot)' : ''}` : 'Any team', r.groundName ?? 'any ground', r.slotName && `${r.slotName} slot`].filter(Boolean).join(' · ');
  const sorted = [...(rules.data ?? [])].sort((a, b) => (a.teamName ?? '~').localeCompare(b.teamName ?? '~') || (a.groundName ?? '').localeCompare(b.groundName ?? ''));

  return (
    <>
      <PageHeader title="Prices" back="/more" action={<Button size="sm" onClick={() => setEditing('new')}>+ Add</Button>} />
      <Page className="space-y-4">
        <EventPricesCard />
        <h3 className="px-1 pt-2 text-xs font-bold uppercase tracking-wide text-muted">Special prices</h3>
        <p className="text-sm text-muted">
          Default prices come from each ground and slot. Add a special price here for a team (e.g. a regular team’s discount) or for a specific ground or slot. It’s pre-filled when booking and can still be changed per booking.
        </p>
        {rules.isLoading ? <Spinner /> : !sorted.length ? <Empty title="No special prices" /> : (
          <Card className="divide-y divide-line overflow-hidden">
            {sorted.map((r) => (
              <button key={r.id} onClick={() => setEditing(r)} className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-paper">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{describe(r)}</div>
                  {r.notes && <div className="truncate text-xs text-muted">{r.notes}</div>}
                </div>
                <div className="font-bold tabular">{inr(r.price)}</div>
              </button>
            ))}
          </Card>
        )}
      </Page>
      {editing && <RuleSheet rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['price-rules'] }); }} />}
    </>
  );
}

/** Rule editor. With fixedTeam (a promoter) the team can't be changed and the price is for the whole slot. */
export function RuleSheet({ rule, onClose, onSaved, fixedTeam }: { rule: PriceRule | null; onClose: () => void; onSaved: () => void; fixedTeam?: { id: string; name: string } }) {
  const teams = useTeams();
  const grounds = useGrounds();
  const [f, setF] = useState({ teamId: fixedTeam?.id ?? rule?.teamId ?? '', groundId: rule?.groundId ?? '', slotTemplateId: rule?.slotTemplateId ?? '', price: (rule?.price ?? '') as number | '' });
  const [error, setError] = useState<unknown>(null);
  const ground = grounds.data?.find((g) => g.id === f.groundId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (f.price === '') return setError(new Error('Enter a price'));
    const body = { teamId: f.teamId || null, groundId: f.groundId || null, slotTemplateId: f.slotTemplateId || null, price: f.price };
    try {
      await api(rule ? `/pricing/rules/${rule.id}` : '/pricing/rules', { method: rule ? 'PATCH' : 'POST', body });
      onSaved();
    } catch (err) { setError(err); }
  }
  async function remove() {
    try { await api(`/pricing/rules/${rule!.id}`, { method: 'DELETE' }); onSaved(); } catch (err) { setError(err); }
  }

  return (
    <Sheet open onClose={onClose} title={rule ? 'Edit special price' : 'New special price'}>
      <form onSubmit={submit} className="space-y-4">
        {fixedTeam ? (
          <p className="text-sm text-muted">Rate for <b className="text-ink">{fixedTeam.name}</b> at a particular ground or slot.</p>
        ) : (
          <Field label="Team">
            <Select value={f.teamId} onChange={(e) => setF({ ...f, teamId: e.target.value })}>
              <option value="">Any team</option>
              {rule?.teamId && rule.teamKind === 'promoter' && <option value={rule.teamId}>{rule.teamName} (promoter)</option>}
              {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Ground">
          <Select value={f.groundId} onChange={(e) => setF({ ...f, groundId: e.target.value, slotTemplateId: '' })}>
            <option value="">Any ground</option>
            {grounds.data?.map((g) => <option key={g.id} value={g.id}>{g.name} · {g.cityName}</option>)}
          </Select>
        </Field>
        {ground && ground.slots.length > 0 && (
          <Field label="Slot">
            <Select value={f.slotTemplateId} onChange={(e) => setF({ ...f, slotTemplateId: e.target.value })}>
              <option value="">Any slot</option>
              {ground.slots.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label={fixedTeam || rule?.teamKind === 'promoter' ? 'Price for the whole slot' : 'Price per team'}><MoneyInput value={f.price} onChange={(v) => setF({ ...f, price: v })} /></Field>
        <ErrorNote error={error} />
        <Button className="w-full">Save</Button>
        {rule && <Button type="button" variant="danger" className="w-full" onClick={remove}>Delete</Button>}
      </form>
    </Sheet>
  );
}

/** Default event prices (whole ground): half day, full day, and tournament per match. */
function EventPricesCard() {
  const me = useMe();
  const qc = useQueryClient();
  const owner = me.data?.user.role === 'owner';
  const ep = me.data?.org.settings.eventPrices;
  const [f, setF] = useState({ halfDay: '' as number | '', fullDay: '' as number | '', tournamentPerMatch: DEFAULT_TOURNAMENT_PER_MATCH as number | '' });
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (me.data) setF({ halfDay: ep?.halfDay ?? '', fullDay: ep?.fullDay ?? '', tournamentPerMatch: ep?.tournamentPerMatch === undefined ? DEFAULT_TOURNAMENT_PER_MATCH : ep.tournamentPerMatch ?? '' });
  }, [me.data]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    setError(null);
    const n = (v: number | '') => (v === '' ? null : v);
    try {
      await api('/settings', { method: 'PATCH', body: { settings: { eventPrices: { halfDay: n(f.halfDay), fullDay: n(f.fullDay), tournamentPerMatch: n(f.tournamentPerMatch) } } } });
      await qc.invalidateQueries({ queryKey: ['me'] });
      setSaved(true);
    } catch (err) { setError(err); }
  }

  return (
    <form onSubmit={save}>
      <Card className="space-y-3 p-4">
        <div>
          <h3 className="font-bold">Event prices</h3>
          <p className="text-xs text-muted">Pre-filled when booking an event (whole ground). Can be changed per booking.</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Half day"><MoneyInput disabled={!owner} value={f.halfDay} onChange={(v) => setF({ ...f, halfDay: v })} /></Field>
          <Field label="Full day"><MoneyInput disabled={!owner} value={f.fullDay} onChange={(v) => setF({ ...f, fullDay: v })} /></Field>
        </div>
        <Field label="Tournament · per match"><MoneyInput disabled={!owner} value={f.tournamentPerMatch} onChange={(v) => setF({ ...f, tournamentPerMatch: v })} /></Field>
        <ErrorNote error={error} />
        {owner ? (
          <div className="flex items-center gap-3">
            <Button size="sm">Save event prices</Button>
            {saved && <span className="text-sm font-semibold text-free">✓ Saved</span>}
          </div>
        ) : <p className="text-xs text-muted">Only the owner can change these.</p>}
      </Card>
    </form>
  );
}
