import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type User } from '../../api';
import { useMe } from '../../hooks';
import { fmtMobile } from '../../lib';
import { Button, Card, ErrorNote, Field, Input, Page, PageHeader, Sheet, Spinner } from '../../components/ui';

/** People who use the app. Listed by name + mobile; sign-in details are added when logins are set up. */
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

  return (
    <>
      <PageHeader title="App users" back="/more" action={<Button size="sm" onClick={() => setAdding(true)}>+ Add</Button>} />
      <Page className="space-y-4">
        <p className="text-sm text-muted">The people who use this app. Sign-in for each of them will be set up later.</p>
        <ErrorNote error={error} />
        {users.isLoading ? <Spinner /> : (
          <Card className="divide-y divide-line">
            {users.data?.map((u) => (
              <div key={u.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className={u.active ? 'font-semibold' : 'font-semibold text-muted line-through'}>{u.name} <span className="text-xs font-medium text-muted">· {u.role}</span></div>
                  <div className="truncate text-sm text-muted">{[fmtMobile(u.mobile), u.email].filter(Boolean).join(' · ') || 'No mobile'}</div>
                </div>
                {u.id !== me.data?.user.id && (
                  <button className="text-sm font-semibold text-muted" onClick={() => toggle(u)}>{u.active ? 'Disable' : 'Enable'}</button>
                )}
              </div>
            ))}
          </Card>
        )}
      </Page>
      {adding && <AddUser onClose={() => setAdding(false)} onSaved={() => { setAdding(false); refresh(); }} />}
    </>
  );
}

function AddUser({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: '', mobile: '' });
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try { await api('/users', { body: { name: f.name.trim(), mobile: f.mobile.trim() } }); onSaved(); } catch (err) { setError(err); }
  }
  return (
    <Sheet open onClose={onClose} title="Add app user">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name"><Input required autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Mobile"><Input required type="tel" inputMode="tel" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} placeholder="98xxxxxxxx" /></Field>
        <ErrorNote error={error} />
        <Button className="w-full">Add</Button>
      </form>
    </Sheet>
  );
}
