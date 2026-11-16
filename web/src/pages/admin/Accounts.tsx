import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type PaymentAccount } from '../../api';
import { useAccounts, useMe } from '../../hooks';
import { cx } from '../../lib';
import { Button, Card, Empty, ErrorNote, Field, Input, Page, PageHeader, Sheet, Spinner, Textarea } from '../../components/ui';

/** Read an image file and shrink it so it stores and sends quickly (QR codes stay sharp at 800px). */
async function readImage(file: File, max = 800): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error('Could not read that image')); i.src = url; });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const png = canvas.toDataURL('image/png');
    return png.length < 1_400_000 ? png : canvas.toDataURL('image/jpeg', 0.9);
  } finally { URL.revokeObjectURL(url); }
}

/** Accounts that receive payments. The chosen account's UPI ID and QR go out in WhatsApp reminders. */
export function AccountsPage() {
  const accounts = useAccounts();
  const me = useMe();
  const owner = me.data?.user.role === 'owner';
  const [editing, setEditing] = useState<PaymentAccount | 'new' | null>(null);
  const [v, setV] = useState(0); // bust the QR image cache after an upload
  const list = [...(accounts.data ?? [])].sort((a, b) => Number(b.active) - Number(a.active) || Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));

  return (
    <>
      <PageHeader title="Payment accounts" back="/more" action={owner && <Button size="sm" onClick={() => setEditing('new')}>+ Add</Button>} />
      <Page className="space-y-4">
        <p className="text-sm text-muted">Where payments are received. Pick the account when sending reminders: its UPI ID and QR code go in the message. When recording a payment, choose which account it came into.</p>
        {accounts.isLoading ? <Spinner /> : !list.length ? <Empty title="No accounts yet">Add each UPI ID / bank account and upload its QR code.</Empty> : (
          <div className="space-y-3">
            {list.map((a) => (
              <Card key={a.id} className={cx('flex items-center gap-3 p-3', !a.active && 'opacity-60')}>
                <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-white">
                  {a.qrUrl ? <img src={`${a.qrUrl}?v=${v}`} alt={`QR for ${a.name}`} className="h-full w-full object-contain" /> : <span className="text-[10px] font-semibold text-muted">No QR</span>}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-bold">
                    {a.name}
                    {a.isDefault && <span className="ml-2 rounded-full bg-pitch/10 px-2 py-0.5 text-[11px] font-semibold text-pitch">Default</span>}
                    {!a.active && <span className="ml-2 text-xs font-medium text-muted">(archived)</span>}
                  </div>
                  <div className="truncate text-sm text-muted">{a.upiId || 'No UPI ID'}{a.holderName ? ` · ${a.holderName}` : ''}</div>
                </div>
                {owner && <Button size="sm" variant="secondary" onClick={() => setEditing(a)}>Edit</Button>}
              </Card>
            ))}
          </div>
        )}
        {!owner && <p className="text-xs text-muted">Only the owner can add or change accounts.</p>}
      </Page>
      {editing && <AccountSheet account={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setV((x) => x + 1); }} />}
    </>
  );
}

function AccountSheet({ account, onClose, onSaved }: { account: PaymentAccount | null; onClose: () => void; onSaved: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: account?.name ?? '', upiId: account?.upiId ?? '', holderName: account?.holderName ?? '', details: account?.details ?? '',
    isDefault: account?.isDefault ?? false, active: account?.active ?? true,
  });
  const [qr, setQr] = useState<string | null | undefined>(undefined); // undefined = unchanged, null = remove
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const preview = qr === undefined ? account?.qrUrl ?? null : qr;

  async function pick(file?: File) {
    if (!file) return;
    setError(null);
    try { setQr(await readImage(file)); } catch (err) { setError(err); }
  }

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['accounts'] }), qc.invalidateQueries({ queryKey: ['dues'] })]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = { name: f.name, upiId: f.upiId.trim() || null, holderName: f.holderName.trim() || null, details: f.details.trim() || null, isDefault: f.isDefault, active: f.active, ...(qr !== undefined ? { qrImage: qr } : {}) };
    try {
      await api(account ? `/accounts/${account.id}` : '/accounts', { method: account ? 'PATCH' : 'POST', body });
      await refresh();
      onSaved();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  async function remove() {
    try { await api(`/accounts/${account!.id}`, { method: 'DELETE' }); await refresh(); onSaved(); } catch (err) { setError(err); }
  }

  return (
    <Sheet open onClose={onClose} title={account ? 'Edit account' : 'New payment account'}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Account name" hint="How you'll recognise it, e.g. “Rahul HDFC” or “Ground PhonePe”">
          <Input required autoFocus={!account} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="UPI ID"><Input value={f.upiId} onChange={(e) => setF({ ...f, upiId: e.target.value })} placeholder="name@okhdfcbank" autoCapitalize="none" /></Field>
        <Field label="Account holder"><Input value={f.holderName} onChange={(e) => setF({ ...f, holderName: e.target.value })} /></Field>
        <Field label="Bank details (optional)"><Textarea rows={2} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} placeholder="A/c no, IFSC" /></Field>

        <Field label="UPI QR code">
          <div className="flex items-center gap-3">
            <div className="grid h-28 w-28 shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-white">
              {preview ? <img src={preview} alt="QR preview" className="h-full w-full object-contain" /> : <span className="text-xs text-muted">No QR</span>}
            </div>
            <div className="space-y-2">
              <span className="inline-flex h-9 cursor-pointer items-center rounded-xl border border-line bg-white px-3 text-sm font-semibold">
                {preview ? 'Replace image' : 'Upload image'}
                <input type="file" accept="image/*" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
              </span>
              {preview && <button type="button" className="block text-sm font-semibold text-full" onClick={() => setQr(null)}>Remove QR</button>}
              <p className="text-xs text-muted">A screenshot of the QR from the UPI app works.</p>
            </div>
          </div>
        </Field>

        <label className="flex items-center gap-3 text-sm font-semibold">
          <input type="checkbox" className="h-5 w-5 accent-[var(--color-pitch)]" checked={f.isDefault} onChange={(e) => setF({ ...f, isDefault: e.target.checked })} />
          Default account for reminders and payments
        </label>
        {account && (
          <label className="flex items-center gap-3 text-sm font-semibold">
            <input type="checkbox" className="h-5 w-5 accent-[var(--color-pitch)]" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
            Active
          </label>
        )}
        <ErrorNote error={error} />
        <Button className="w-full" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        {account && (confirmDelete ? (
          <div className="flex gap-2">
            <Button type="button" variant="danger" className="flex-1" onClick={remove}>Yes, delete</Button>
            <Button type="button" variant="secondary" className="flex-1" onClick={() => setConfirmDelete(false)}>Keep</Button>
          </div>
        ) : (
          <Button type="button" variant="danger" className="w-full" onClick={() => setConfirmDelete(true)}>Delete account</Button>
        ))}
        {account && <p className="text-center text-xs text-muted">If payments were recorded to it, it's archived instead so history stays.</p>}
      </form>
    </Sheet>
  );
}
