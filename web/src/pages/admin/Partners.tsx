import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type User } from '../../api';
import { useMe } from '../../hooks';
import { Button, Card, ErrorNote, Field, Input, Page, PageHeader, Sheet, Spinner } from '../../components/ui';

export function PartnersPage() {
  const qc = useQueryClient();
  const me = useMe();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<User[]>('/users') });
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });

  async function toggle(u: User) {
    try { await api(`/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } }); refresh(); } catch (err) { setError(err); }
  }
  async function resetPassword(u: User) {
    const password = window.prompt(`New password for ${u.name} (min 8 characters)`);
    if (!password) return;
    try { await api(`/users/${u.id}`, { method: 'PATCH', body: { password } }); } catch (err) { setError(err); }
  }

  return (
    <>
      <PageHeader title="Partners" back="/more" action={<Button size="sm" onClick={() => setAdding(true)}>+ Add</Button>} />
      <Page className="space-y-4">
        <p className="text-sm text-muted">Partners can make bookings, record payments and see reports. Only owners can manage partners and settings.</p>
        <ErrorNote error={error} />
        {users.isLoading ? <Spinner /> : (
          <Card className="divide-y divide-line">
            {users.data?.map((u) => (
              <div key={u.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className={u.active ? 'font-semibold' : 'font-semibold text-muted line-through'}>{u.name} <span className="text-xs font-medium text-muted">· {u.role}</span></div>
                  <div className="truncate text-sm text-muted">{u.email}</div>
                </div>
                {u.id !== me.data?.user.id && (
                  <>
                    <button className="text-sm font-semibold text-pitch" onClick={() => resetPassword(u)}>Reset</button>
                    <button className="text-sm font-semibold text-muted" onClick={() => toggle(u)}>{u.active ? 'Disable' : 'Enable'}</button>
                  </>
                )}
              </div>
            ))}
          </Card>
        )}
      </Page>
      {adding && <AddPartner onClose={() => setAdding(false)} onSaved={() => { setAdding(false); refresh(); }} />}
    </>
  );
}

function AddPartner({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: '', email: '', mobile: '', password: '' });
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try { await api('/users', { body: { ...f, mobile: f.mobile || undefined } }); onSaved(); } catch (err) { setError(err); }
  }
  return (
    <Sheet open onClose={onClose} title="Add partner">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email (used to sign in)"><Input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Mobile"><Input type="tel" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} /></Field>
        <Field label="Temporary password" hint="Share it with them; they can change it later"><Input required minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <ErrorNote error={error} />
        <Button className="w-full">Add partner</Button>
      </form>
    </Sheet>
  );
}
