import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type PriceRule, type Team } from '../../api';
import { usePromoters } from '../../hooks';
import { inr, pocLine } from '../../lib';
import { Button, Card, Empty, ErrorNote, Field, Input, ListLink, MoneyInput, Page, PageHeader, Sheet, Spinner } from '../../components/ui';
import { RuleSheet } from './Pricing';

/**
 * Promoters (e.g. Rana, Ravinder) take a whole slot and fill it themselves.
 * Each has their own discounted rate: a default per slot, plus optional rates
 * for particular grounds or slots.
 */
export function PromotersPage() {
  const promoters = usePromoters(true);
  const [adding, setAdding] = useState(false);
  const nav = useNavigate();
  const list = [...(promoters.data ?? [])].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  return (
    <>
      <PageHeader title="Promoters" back="/more" action={<Button size="sm" onClick={() => setAdding(true)}>+ Add</Button>} />
      <Page className="space-y-4">
        <p className="text-sm text-muted">A promoter books the whole slot at their own discounted rate. Pick “Promoter” when booking a slot.</p>
        {promoters.isLoading ? <Spinner /> : !list.length ? <Empty title="No promoters yet" /> : (
          <Card className="divide-y divide-line overflow-hidden">
            {list.map((t) => (
              <ListLink key={t.id} to={`/admin/promoters/${t.id}`}
                title={<>{t.name}{!t.active && <span className="ml-2 text-xs font-medium text-muted">(inactive)</span>}</>}
                sub={pocLine(t.poc?.name, t.poc?.mobile)}
                right={<span className="text-sm font-bold tabular">{t.defaultRate != null ? `${inr(t.defaultRate)}/slot` : <span className="font-medium text-muted">No rate</span>}</span>} />
            ))}
          </Card>
        )}
      </Page>
      {adding && <PromoterSheet onClose={() => setAdding(false)} onSaved={(t) => { setAdding(false); nav(`/admin/promoters/${t.id}`); }} />}
    </>
  );
}

function PromoterSheet({ promoter, onClose, onSaved }: { promoter?: Team; onClose: () => void; onSaved: (t: Team) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: promoter?.name ?? '', contactName: '', mobile: '', defaultRate: (promoter?.defaultRate ?? '') as number | '', notes: promoter?.notes ?? '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const base = { name: f.name, defaultRate: f.defaultRate === '' ? null : f.defaultRate, notes: f.notes || null };
    try {
      const t = promoter
        ? await api<Team>(`/teams/${promoter.id}`, { method: 'PATCH', body: base })
        : await api<Team>('/teams', { body: { ...base, notes: f.notes || undefined, kind: 'promoter', allowDuplicateName: true,
          contacts: f.mobile.trim() ? [{ name: f.contactName.trim() || f.name, mobile: f.mobile }] : [] } });
      await Promise.all([qc.invalidateQueries({ queryKey: ['promoters'] }), qc.invalidateQueries({ queryKey: ['promoter', t.id] })]);
      onSaved(t);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 422 ? new Error(err.message.replace(/^contacts\.0\.mobile:.*/, 'Enter a valid mobile number')) : err);
    } finally { setBusy(false); }
  }

  return (
    <Sheet open onClose={onClose} title={promoter ? 'Edit promoter' : 'New promoter'}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name"><Input required autoFocus={!promoter} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Rana" /></Field>
        {!promoter && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Contact name"><Input value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} placeholder="Same as name" /></Field>
            <Field label="Mobile"><Input inputMode="tel" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} placeholder="98xxxxxxxx" /></Field>
          </div>
        )}
        <Field label="Default rate for a slot" hint="Their discounted price for a whole slot. Add ground- or slot-specific rates on the next screen.">
          <MoneyInput value={f.defaultRate} onChange={(v) => setF({ ...f, defaultRate: v })} />
        </Field>
        <Field label="Notes"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <ErrorNote error={error} />
        <Button className="w-full" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
      </form>
    </Sheet>
  );
}

export function PromoterDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const promoters = usePromoters(true);
  const rules = useQuery({ queryKey: ['price-rules'], queryFn: () => api<PriceRule[]>('/pricing/rules') });
  const [editing, setEditing] = useState(false);
  const [rule, setRule] = useState<PriceRule | 'new' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const t = promoters.data?.find((x) => x.id === id);
  const mine = (rules.data ?? []).filter((r) => r.teamId === id)
    .sort((a, b) => (a.groundName ?? '').localeCompare(b.groundName ?? '') || (a.slotName ?? '').localeCompare(b.slotName ?? ''));

  async function setActive(active: boolean) {
    try {
      await api(`/teams/${id}`, { method: 'PATCH', body: { active } });
      await qc.invalidateQueries({ queryKey: ['promoters'] });
    } catch (err) { setError(err); }
  }

  if (promoters.isLoading) return <><PageHeader title="Promoter" back="/admin/promoters" /><Spinner /></>;
  if (!t) return <><PageHeader title="Promoter" back="/admin/promoters" /><Page><Empty title="Promoter not found" /></Page></>;

  return (
    <>
      <PageHeader title={t.name} back="/admin/promoters" action={<Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit</Button>} />
      <Page className="space-y-5">
        <Card className="p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Default rate</div>
          <div className="font-display text-2xl font-bold tabular">{t.defaultRate != null ? `${inr(t.defaultRate)} / slot` : 'Not set'}</div>
          {t.defaultRate == null && <p className="mt-1 text-xs text-muted">Without a rate, bookings default to two teams’ price.</p>}
          {t.notes && <p className="mt-2 text-sm text-muted">{t.notes}</p>}
        </Card>

        <section>
          <div className="mb-2 flex items-center justify-between px-1">
            <h3 className="text-xs font-bold uppercase tracking-wide text-muted">Rates for particular grounds / slots</h3>
            <button className="text-sm font-semibold text-pitch" onClick={() => setRule('new')}>+ Add rate</button>
          </div>
          {!mine.length ? (
            <p className="px-1 text-sm text-muted">None. The default rate applies everywhere.</p>
          ) : (
            <Card className="divide-y divide-line overflow-hidden">
              {mine.map((r) => (
                <button key={r.id} onClick={() => setRule(r)} className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-paper">
                  <div className="min-w-0 flex-1 truncate font-semibold">{[r.groundName ?? 'Any ground', r.slotName && `${r.slotName} slot`].filter(Boolean).join(' · ')}</div>
                  <div className="font-bold tabular">{inr(r.price)}</div>
                </button>
              ))}
            </Card>
          )}
        </section>

        <Card className="divide-y divide-line overflow-hidden">
          <ListLink to={`/admin/teams/${t.id}`} title="Contacts & booking history" sub={pocLine(t.poc?.name, t.poc?.mobile)} />
          <Link to={`/dues`} className="block px-4 py-3.5 text-sm font-semibold text-pitch">See dues ›</Link>
        </Card>

        <ErrorNote error={error} />
        <Button variant={t.active ? 'danger' : 'secondary'} className="w-full" onClick={() => setActive(!t.active)}>
          {t.active ? 'Mark inactive' : 'Make active again'}
        </Button>
        {t.active && <p className="-mt-3 text-center text-xs text-muted">Inactive promoters are hidden when booking; history is kept.</p>}
      </Page>
      {editing && <PromoterSheet promoter={t} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />}
      {rule && <RuleSheet rule={rule === 'new' ? null : rule} fixedTeam={{ id: t.id, name: t.name }}
        onClose={() => setRule(null)} onSaved={() => { setRule(null); qc.invalidateQueries({ queryKey: ['price-rules'] }); }} />}
    </>
  );
}
