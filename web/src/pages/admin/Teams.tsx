import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Booking, type Contact, type SameNameTeam, type Team } from '../../api';
import { useTeams } from '../../hooks';
import { cx, fmtDate, fmtMobile, fmtRange, inr, pocLine } from '../../lib';
import { Button, Card, Empty, ErrorNote, Field, Input, ListLink, Page, PageHeader, Select, Sheet, Spinner, StatusBadge } from '../../components/ui';

export function TeamsAdminPage() {
  const teams = useTeams();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const ql = q.trim().toLowerCase(), qd = q.replace(/\D/g, '');
  const all = teams.data ?? [];
  const dupNames = new Set(all.map((t) => t.name.toLowerCase()).filter((n, i, xs) => xs.indexOf(n) !== i));
  const list = all.filter((t) => !ql || t.name.toLowerCase().includes(ql)
    || t.contacts.some((c) => c.name.toLowerCase().includes(ql) || (qd.length >= 4 && c.mobile.includes(qd)))).slice(0, 300);
  return (
    <>
      <PageHeader title="Teams" back="/more" action={<Button size="sm" onClick={() => setAdding(true)}>+ Add</Button>}
        sub={<Input type="search" placeholder="Search team, POC or mobile" value={q} onChange={(e) => setQ(e.target.value)} />} />
      <Page>
        {teams.isLoading ? <Spinner /> : !list.length ? <Empty title={q ? 'No matching teams' : 'No teams yet'}>Teams are also added automatically when you book.</Empty> : (
          <Card className="divide-y divide-line overflow-hidden">
            {list.map((t) => (
              <ListLink key={t.id} to={`/admin/teams/${t.id}`}
                title={<>{t.name}{dupNames.has(t.name.toLowerCase()) && <span className="ml-1.5 rounded bg-partial-bg px-1.5 py-0.5 text-[10px] font-bold uppercase text-partial">Same name</span>}</>}
                sub={<span className={cx('tabular', !t.poc && 'text-partial')}>{pocLine(t.poc?.name, t.poc?.mobile)}</span>}
                right={<span className="text-xs text-muted">{t.bookingCount} bkg</span>} />
            ))}
          </Card>
        )}
      </Page>
      <NewTeamSheet open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

function NewTeamSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', contactName: '', mobile: '' });
  const [error, setError] = useState<unknown>(null);
  const [sameName, setSameName] = useState<SameNameTeam[] | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const t = await api<Team>('/teams', { body: { name: f.name, contacts: f.contactName && f.mobile ? [{ name: f.contactName, mobile: f.mobile }] : [], ...(sameName ? { allowDuplicateName: true } : {}) } });
      await qc.invalidateQueries({ queryKey: ['teams'] });
      setSameName(null);
      onClose();
      nav(`/admin/teams/${t.id}`);
    } catch (err) {
      const d = err instanceof ApiError ? err.details as { code?: string; teams?: SameNameTeam[] } | undefined : undefined;
      if (d?.code === 'team_name_exists' && d.teams) setSameName(d.teams);
      else setError(err);
    }
  }
  return (
    <Sheet open={open} onClose={onClose} title="New team">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Team name"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
        <Field label="Contact name (POC)"><Input value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} /></Field>
        <Field label="Mobile"><Input type="tel" inputMode="tel" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} placeholder="98765 43210" /></Field>
        {sameName && (
          <div className="rounded-xl bg-partial-bg p-3 text-sm">
            <p className="font-semibold text-partial">Already have {sameName.length === 1 ? 'a team' : `${sameName.length} teams`} with this name:</p>
            <ul className="mt-1.5 space-y-1">
              {sameName.map((t) => <li key={t.id}><Link className="font-semibold underline" to={`/admin/teams/${t.id}`} onClick={onClose}>{t.name}</Link> <span className="text-muted">· {pocLine(t.poc?.name, t.poc?.mobile)}</span></li>)}
            </ul>
            <p className="mt-2 text-xs text-muted">If this is a different team, add its POC and tap the button again.</p>
          </div>
        )}
        <ErrorNote error={error} />
        <Button className="w-full">{sameName ? 'Add as a different team' : 'Add team'}</Button>
      </form>
    </Sheet>
  );
}

type TeamDetail = Team & { contacts: Contact[]; bookings: Booking[]; totals: { billed: number; paid: number; balance: number } };

export function TeamDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const teams = useTeams();
  const q = useQuery({ queryKey: ['team', id], queryFn: () => api<TeamDetail>(`/teams/${id}`) });
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [merging, setMerging] = useState(false);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['team', id] }), qc.invalidateQueries({ queryKey: ['teams'] }), qc.invalidateQueries({ queryKey: ['dues'] })]);

  if (q.isLoading) return <><PageHeader title="Team" back /><Spinner /></>;
  if (!q.data) return <><PageHeader title="Team" back /><Page><ErrorNote error={q.error} /></Page></>;
  const t = q.data;

  return (
    <>
      <PageHeader title={t.name} sub={<p className="text-sm text-muted tabular">POC: {pocLine(t.poc?.name, t.poc?.mobile)}</p>} back action={<Button size="sm" variant="secondary" onClick={() => setRenaming(true)}>Edit</Button>} />
      <Page className="space-y-5">
        <div className="grid grid-cols-3 gap-2">
          {[['Billed', t.totals.billed, ''], ['Paid', t.totals.paid, 'text-free'], ['Balance', t.totals.balance, t.totals.balance > 0 ? 'text-full' : '']].map(([l, v, c]) => (
            <Card key={l as string} className="p-3">
              <div className="text-[11px] font-bold uppercase tracking-wide text-muted">{l}</div>
              <div className={cx('text-lg font-bold tabular', c as string)}>{inr(v as number)}</div>
            </Card>
          ))}
        </div>

        <section>
          <div className="mb-2 flex items-center justify-between px-1">
            <h3 className="text-xs font-bold uppercase tracking-wide text-muted">Contacts (POC)</h3>
            <button className="text-sm font-semibold text-pitch" onClick={() => setEditing('new')}>+ Add</button>
          </div>
          {t.contacts.length === 0 ? <Empty title="No contacts">Add a POC so you can send payment reminders.</Empty> : (
            <Card className="divide-y divide-line">
              {t.contacts.map((c) => (
                <div key={c.id} className={cx('flex items-center gap-3 px-4 py-3', !c.active && 'opacity-55')}>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{c.name}
                      {c.id === t.poc?.contactId && <span className="ml-1.5 rounded bg-pitch/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-pitch">Active POC</span>}
                      {!c.active && <span className="ml-1.5 rounded bg-line px-1.5 py-0.5 text-[10px] font-bold uppercase text-muted">Former</span>}
                    </div>
                    <a href={`tel:${c.mobile}`} className="text-sm tabular text-muted">{fmtMobile(c.mobile)}</a>
                  </div>
                  {c.active && <a href={`https://wa.me/${c.mobile.replace(/\D/g, '')}`} target="_blank" rel="noreferrer" className="rounded-lg bg-[#1f9d55] px-2.5 py-1.5 text-xs font-bold text-white">WhatsApp</a>}
                  <button className="px-1 text-sm font-semibold text-pitch" onClick={() => setEditing(c)}>Edit</button>
                </div>
              ))}
            </Card>
          )}
        </section>

        <section>
          <h3 className="mb-2 px-1 text-xs font-bold uppercase tracking-wide text-muted">Bookings</h3>
          {t.bookings.length === 0 ? <Empty title="No bookings yet" /> : (
            <Card className="divide-y divide-line overflow-hidden">
              {t.bookings.map((b) => {
                const mine = b.parties.find((p) => p.teamId === t.id)!;
                return (
                  <Link key={b.id} to={`/bookings/${b.id}`} className="flex items-center gap-3 px-4 py-3 active:bg-paper">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{fmtDate(b.date, { day: 'numeric', month: 'short', year: '2-digit' })} · {b.groundName}</div>
                      <div className="truncate text-xs text-muted">{fmtRange(b.startTime, b.endTime)} · {b.kind === 'event' ? b.title || 'Event' : b.kind === 'promoter' ? 'Promoter slot' : b.parties.map((p) => p.teamName).join(' vs ')}</div>
                    </div>
                    <div className="text-right">
                      <div className={cx('text-sm font-bold tabular', mine.balance > 0 && 'text-full')}>{mine.balance > 0 ? inr(mine.balance) : '✓'}</div>
                      {b.status !== 'confirmed' && <StatusBadge status={b.status} />}
                    </div>
                  </Link>
                );
              })}
            </Card>
          )}
        </section>

        <button className="w-full py-2 text-sm font-semibold text-muted" onClick={() => setMerging(true)}>Duplicate team? Merge into another…</button>
      </Page>

      {editing && <ContactSheet teamId={t.id} contact={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {renaming && <RenameSheet team={t} onClose={() => setRenaming(false)} onSaved={() => { setRenaming(false); refresh(); }} />}
      <Sheet open={merging} onClose={() => setMerging(false)} title={`Merge ${t.name}`}>
        <MergeForm team={t} teams={(teams.data ?? []).filter((x) => x.id !== t.id)} onDone={async (into) => { await refresh(); setMerging(false); nav(`/admin/teams/${into}`, { replace: true }); }} />
      </Sheet>
    </>
  );
}

function ContactSheet({ teamId, contact, onClose, onSaved }: { teamId: string; contact: Contact | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: contact?.name ?? '', mobile: contact?.mobile ?? '', isPrimary: contact?.isPrimary ?? false, active: contact?.active ?? true });
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      if (contact) await api(`/teams/contacts/${contact.id}`, { method: 'PATCH', body: f });
      else await api(`/teams/${teamId}/contacts`, { body: { name: f.name, mobile: f.mobile, ...(f.isPrimary ? { isPrimary: true } : {}) } });
      onSaved();
    } catch (err) { setError(err); }
  }
  async function remove() {
    try { await api(`/teams/contacts/${contact!.id}`, { method: 'DELETE' }); onSaved(); } catch (err) { setError(err); }
  }
  return (
    <Sheet open onClose={onClose} title={contact ? 'Edit contact' : 'Add contact'}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
        <Field label="Mobile" hint="10-digit Indian numbers get +91 added"><Input required type="tel" inputMode="tel" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} /></Field>
        <label className="flex items-center gap-3 text-sm font-semibold">
          <input type="checkbox" className="h-5 w-5 accent-pitch" checked={f.isPrimary} onChange={(e) => setF({ ...f, isPrimary: e.target.checked })} />
          Primary contact (shown with the team, used for “Remind all”)
        </label>
        {contact && (
          <label className="flex items-center gap-3 text-sm font-semibold">
            <input type="checkbox" className="h-5 w-5 accent-pitch" checked={!f.active} onChange={(e) => setF({ ...f, active: !e.target.checked, isPrimary: e.target.checked ? false : f.isPrimary })} />
            Former contact (no longer with the team; kept for history)
          </label>
        )}
        <ErrorNote error={error} />
        <Button className="w-full">Save</Button>
        {contact && <Button type="button" variant="danger" className="w-full" onClick={remove}>Remove contact</Button>}
      </form>
    </Sheet>
  );
}

function RenameSheet({ team, onClose, onSaved }: { team: Team; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(team.name);
  const [notes, setNotes] = useState(team.notes ?? '');
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try { await api(`/teams/${team.id}`, { method: 'PATCH', body: { name, notes: notes || null } }); onSaved(); } catch (err) { setError(err); }
  }
  return (
    <Sheet open onClose={onClose} title="Edit team">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Team name"><Input required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <ErrorNote error={error} />
        <Button className="w-full">Save</Button>
      </form>
    </Sheet>
  );
}

function MergeForm({ team, teams, onDone }: { team: Team; teams: Team[]; onDone: (into: string) => void }) {
  const [into, setInto] = useState('');
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try { await api(`/teams/${team.id}/merge`, { body: { intoTeamId: into } }); onDone(into); } catch (err) { setError(err); }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-muted">All of <b className="text-ink">{team.name}</b>’s bookings, payments and contacts move to the team you pick, and {team.name} is removed.</p>
      <Field label="Merge into">
        <Select required value={into} onChange={(e) => setInto(e.target.value)}>
          <option value="" disabled>Choose team (name · POC)</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name} · {pocLine(t.poc?.name, t.poc?.mobile)}</option>)}
        </Select>
      </Field>
      <ErrorNote error={error} />
      <Button variant="danger" className="w-full" disabled={!into}>Merge</Button>
    </form>
  );
}
