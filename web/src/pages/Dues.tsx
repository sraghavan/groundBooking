import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DuesResponse, type PayTo, type TeamDue } from '../api';
import { useAccounts } from '../hooks';
import { cx, fmtDate, fmtRange, inr, timeAgo, todayISO } from '../lib';
import { Button, Card, Chip, Empty, ErrorNote, Page, PageHeader, Segmented, Spinner } from '../components/ui';

const ACCOUNT_KEY = 'gb_reminder_account';
const loadAccount = () => { try { return localStorage.getItem(ACCOUNT_KEY); } catch { return null; } };
const saveAccount = (id: string) => { try { localStorage.setItem(ACCOUNT_KEY, id); } catch { /* ignore */ } };

/** Can this device share an image file (phone share sheet → WhatsApp)? */
const canShareFiles = () => typeof navigator !== 'undefined' && !!navigator.canShare
  && navigator.canShare({ files: [new File([''], 'qr.png', { type: 'image/png' })] });

/** Share the QR image with the reminder text via the phone's share sheet. */
async function shareQr(payTo: PayTo, text: string) {
  const res = await fetch(payTo.qrUrl!);
  const blob = await res.blob();
  const file = new File([blob], `${payTo.name.replace(/[^\w-]+/g, '_')}-QR.${blob.type.split('/')[1] ?? 'png'}`, { type: blob.type });
  await navigator.share({ files: [file], text });
}
const messageOf = (whatsappUrl: string) => decodeURIComponent(new URL(whatsappUrl).searchParams.get('text') ?? '');

type Mode = 'due' | 'all';

export function DuesPage() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>('due');
  const upTo = mode === 'due' ? todayISO() : '2999-12-31';
  const accounts = useAccounts();
  const live = (accounts.data ?? []).filter((a) => a.active);
  const [picked, setPicked] = useState<string | null>(loadAccount);
  const accountId = live.some((a) => a.id === picked) ? picked : null; // null → server default
  const q = useQuery({
    queryKey: ['dues', upTo, accountId],
    queryFn: () => api<DuesResponse>(`/dues?upTo=${upTo}${accountId ? `&accountId=${accountId}` : ''}`),
  });
  const payTo = q.data?.payTo ?? null;
  const shareable = !!payTo?.qrUrl && canShareFiles();
  const [shareError, setShareError] = useState<unknown>(null);

  async function shareWithQr(team: TeamDue, c: TeamDue['contacts'][number]) {
    setShareError(null);
    try {
      await shareQr(payTo!, messageOf(c.whatsappUrl));
      setSent((x) => new Set(x).add(c.id));
      api('/dues/reminders', { body: { teamId: team.teamId, contactId: c.id, amount: team.balance } }).then(() => qc.invalidateQueries({ queryKey: ['dues'] })).catch(() => {});
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) setShareError(err);
    }
  }
  const [queue, setQueue] = useState<{ team: TeamDue; contactIdx: number }[] | null>(null);
  const [sent, setSent] = useState<Set<string>>(new Set());

  /** Open WhatsApp with the pre-filled reminder and log it. */
  async function remind(team: TeamDue, c: TeamDue['contacts'][number]) {
    window.open(c.whatsappUrl, '_blank', 'noopener');
    setSent((s) => new Set(s).add(c.id));
    try {
      await api('/dues/reminders', { body: { teamId: team.teamId, contactId: c.id, amount: team.balance } });
      qc.invalidateQueries({ queryKey: ['dues'] });
    } catch { /* logging is best-effort */ }
  }

  // "Remind everyone" steps through each team's primary contact. Each tap opens one
  // WhatsApp chat (browsers block opening many at once; WhatsApp needs a tap to send anyway).
  const withContacts = (q.data?.teams ?? []).filter((t) => t.contacts.length);
  const noContacts = (q.data?.teams ?? []).filter((t) => !t.contacts.length);
  const current = queue?.[0];

  return (
    <>
      <PageHeader title="Payments due" sub={<Segmented value={mode} onChange={setMode} options={[{ value: 'due', label: 'Due now' }, { value: 'all', label: 'Incl. upcoming' }]} />} />
      <Page>
        <ErrorNote error={q.error} />
        {q.isLoading ? <Spinner /> : !q.data?.teams.length ? <Empty title="Nothing pending">All payments are settled.</Empty> : (
          <>
            <Card className="mb-4 flex items-center gap-4 bg-pitch p-4 text-white">
              <div className="flex-1">
                <div className="text-xs font-semibold uppercase tracking-wide text-white/70">Outstanding</div>
                <div className="font-display text-3xl font-bold tabular">{inr(q.data.total)}</div>
                <div className="text-sm text-white/75">{q.data.teams.length} team{q.data.teams.length > 1 ? 's' : ''}</div>
              </div>
              {withContacts.length > 0 && (
                <Button variant="whatsapp" onClick={() => setQueue(withContacts.map((team) => ({ team, contactIdx: 0 })))}>Remind all</Button>
              )}
            </Card>

            <Card className="mb-4 p-3">
              <div className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Ask them to pay into</div>
              {live.length ? (
                <div className="no-scrollbar -mx-3 flex gap-2 overflow-x-auto px-3">
                  {live.map((a) => (
                    <Chip key={a.id} active={a.id === payTo?.accountId} onClick={() => { setPicked(a.id); saveAccount(a.id); }}>{a.name}</Chip>
                  ))}
                </div>
              ) : (
                <Link to="/admin/accounts" className="text-sm font-semibold text-pitch">+ Add a payment account with its QR code</Link>
              )}
              {payTo && (
                <div className="mt-2 flex items-center gap-3">
                  {payTo.qrUrl && <img src={payTo.qrUrl} alt="" className="h-12 w-12 rounded-lg border border-line bg-white object-contain" />}
                  <p className="text-xs text-muted">
                    {payTo.upiId ? <>UPI <b className="text-ink">{payTo.upiId}</b>. </> : 'No UPI ID. '}
                    {payTo.qrUrl ? 'The QR link goes in the message.' : <>No QR yet. <Link to="/admin/accounts" className="font-semibold text-pitch">Upload one</Link>.</>}
                    {shareable && ' Use “QR” to send the image itself.'}
                  </p>
                </div>
              )}
            </Card>
            <ErrorNote error={shareError} />

            {current && (
              <Card className="mb-4 border-[#1f9d55]/40 bg-[#e9f8ef] p-4">
                <div className="text-xs font-bold uppercase tracking-wide text-[#178246]">Reminding {withContacts.length - queue!.length + 1} of {withContacts.length}</div>
                <div className="mt-1 font-semibold">{current.team.teamName} · {inr(current.team.balance)}</div>
                <div className="text-sm text-muted">to {current.team.contacts[0].name} ({current.team.contacts[0].mobile})</div>
                <div className="mt-3 flex gap-2">
                  <Button variant="whatsapp" className="flex-1" onClick={() => { remind(current.team, current.team.contacts[0]); setQueue(queue!.slice(1).length ? queue!.slice(1) : null); }}>Open WhatsApp</Button>
                  <Button variant="secondary" onClick={() => setQueue(queue!.slice(1).length ? queue!.slice(1) : null)}>Skip</Button>
                  <Button variant="ghost" onClick={() => setQueue(null)}>Stop</Button>
                </div>
              </Card>
            )}

            {noContacts.length > 0 && (
              <p className="mb-3 rounded-xl bg-partial-bg px-3 py-2 text-sm text-partial">
                {noContacts.length} team{noContacts.length > 1 ? 's have' : ' has'} no contact number: {noContacts.map((t) => t.teamName).join(', ')}
              </p>
            )}

            <div className="space-y-3">
              {q.data.teams.map((t) => (
                <Card key={t.teamId} className="overflow-hidden">
                  <div className="flex items-start gap-3 p-4">
                    <Link to={`/admin/teams/${t.teamId}`} className="min-w-0 flex-1">
                      <div className="truncate text-[17px] font-bold">
                        {t.teamName}
                        {t.teamKind === 'promoter' && <span className="ml-2 rounded-full bg-pitch/10 px-2 py-0.5 align-middle text-[11px] font-semibold text-pitch">Promoter</span>}
                      </div>
                      <div className="text-xs text-muted">{t.lines.length} booking{t.lines.length > 1 ? 's' : ''}{t.lastRemindedAt ? ` · reminded ${timeAgo(t.lastRemindedAt)}` : ''}</div>
                    </Link>
                    <div className="text-right text-lg font-bold text-full tabular">{inr(t.balance)}</div>
                  </div>
                  <div className="divide-y divide-line border-t border-line">
                    {t.lines.map((l) => (
                      <Link key={l.bookingPartyId} to={`/bookings/${l.bookingId}`} className="flex items-center gap-3 px-4 py-2.5 text-sm active:bg-paper">
                        <div className="min-w-0 flex-1">
                          <span className="font-semibold">{fmtDate(l.date)}</span>
                          <span className="text-muted"> · {l.groundName} · {fmtRange(l.startTime, l.endTime)}</span>
                        </div>
                        <span className={cx('tabular', l.paid > 0 && 'text-partial')}>{inr(l.balance)}{l.paid > 0 && <span className="text-xs text-muted"> of {inr(l.amountDue)}</span>}</span>
                      </Link>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2 border-t border-line bg-paper/60 p-3">
                    {t.contacts.length ? t.contacts.map((c) => (
                      <span key={c.id} className="flex gap-1">
                        <Button size="sm" variant={sent.has(c.id) ? 'secondary' : 'whatsapp'} onClick={() => remind(t, c)}>
                          {sent.has(c.id) ? '✓ ' : ''}WhatsApp {c.name.split(' ')[0]}
                        </Button>
                        {shareable && <Button size="sm" variant="secondary" onClick={() => shareWithQr(t, c)} title="Share the QR image with the message">QR</Button>}
                      </span>
                    )) : (
                      <Link to={`/admin/teams/${t.teamId}`} className="text-sm font-semibold text-pitch">+ Add a contact</Link>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          </>
        )}
      </Page>
    </>
  );
}
