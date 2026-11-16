import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { uploadFile } from '../../api';
import { useMe } from '../../hooks';
import { fmtDate } from '../../lib';
import { Button, Card, ConfirmSheet, ErrorNote, Page, PageHeader } from '../../components/ui';

type Summary = {
  bookings: number; teams: number; grounds: number; issues: number;
  matches: number; waiting: number; promoter: number; holds: number;
  from: string | null; to: string | null; perGround: { name: string; bookings: number }[]; issueList: string[];
};
type Result = { loaded: boolean; summary: Summary; result?: { bookings: number; teams: number; grounds: number } };

/** Owner uploads the bookings workbook: check what's in it, then replace grounds, teams and bookings with it. */
export function ImportPage() {
  const me = useMe();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [checked, setChecked] = useState<Result | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<'check' | 'load' | null>(null);
  const [error, setError] = useState<unknown>(null);

  if (me.data && me.data.user.role !== 'owner') {
    return (<><PageHeader title="Import from Excel" back="/more" /><Page><p className="text-sm text-muted">Only the owner can import data.</p></Page></>);
  }

  async function run(replace: boolean) {
    if (!file) return;
    setBusy(replace ? 'load' : 'check');
    setError(null);
    try {
      const r = await uploadFile<Result>(`/import${replace ? '?replace=1' : ''}`, file);
      if (replace) { setDone(r); setChecked(null); setFile(null); await qc.invalidateQueries(); }
      else setChecked(r);
    } catch (err) { setError(err); } finally { setBusy(null); setConfirm(false); }
  }

  const s = checked?.summary;
  return (
    <>
      <PageHeader title="Import from Excel" back="/more" />
      <Page className="space-y-4">
        <p className="text-sm text-muted">
          Upload the bookings workbook (.xlsx). Loading it <b className="text-ink">replaces all grounds, slots, teams and bookings</b>, including payments recorded against those bookings.
          App users, settings, payment accounts and promoters (with their rates) are kept.
        </p>

        <Card className="space-y-3 p-4">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">Workbook</span>
            <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setChecked(null); setDone(null); setError(null); }}
              className="block w-full text-sm file:mr-3 file:rounded-full file:border-0 file:bg-pitch file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white" />
          </label>
          <Button type="button" variant="secondary" className="w-full" disabled={!file || !!busy} onClick={() => run(false)}>
            {busy === 'check' ? 'Reading…' : 'Check file'}
          </Button>
          <ErrorNote error={error} />
        </Card>

        {s && (
          <Card className="space-y-3 p-4">
            <div className="text-sm font-bold">In this file</div>
            <div className="grid grid-cols-3 gap-2 text-center">
              {[['Grounds', s.grounds], ['Teams', s.teams], ['Bookings', s.bookings]].map(([k, n]) => (
                <div key={k} className="rounded-xl bg-paper p-2"><div className="text-lg font-bold tabular">{Number(n).toLocaleString('en-IN')}</div><div className="text-xs text-muted">{k}</div></div>
              ))}
            </div>
            <p className="text-xs text-muted">
              {s.from && s.to ? `${fmtDate(s.from)} to ${fmtDate(s.to)}. ` : ''}
              {s.matches} matches with both teams, {s.waiting} waiting for an opponent, {s.promoter} promoter slots, {s.holds} other whole-slot holds.
            </p>
            <table className="w-full text-sm">
              <tbody>
                {s.perGround.map((g) => (
                  <tr key={g.name} className="border-t border-line/60"><td className="py-1">{g.name}</td><td className="py-1 text-right tabular">{g.bookings.toLocaleString('en-IN')}</td></tr>
                ))}
              </tbody>
            </table>
            {s.issues > 0 && (
              <details className="text-xs text-partial"><summary className="cursor-pointer font-semibold">{s.issues} cells couldn't be read</summary>
                <ul className="mt-1 list-disc pl-4">{s.issueList.map((i) => <li key={i}>{i}</li>)}</ul></details>
            )}
            <Button type="button" className="w-full" disabled={!!busy} onClick={() => setConfirm(true)}>
              {busy === 'load' ? 'Loading… (this can take a minute)' : 'Replace data with this file'}
            </Button>
          </Card>
        )}

        {done?.result && (
          <Card className="border-free/40 bg-free/5 p-4 text-sm">
            <b>Loaded.</b> {done.result.grounds} grounds, {done.result.teams.toLocaleString('en-IN')} teams and {done.result.bookings.toLocaleString('en-IN')} bookings.
            Slot times were set to the standard slots; check prices under Grounds &amp; slots.
          </Card>
        )}

        {confirm && (
          <ConfirmSheet title="Replace all bookings data?" confirmLabel="Yes, replace" onCancel={() => setConfirm(false)} onConfirm={() => run(true)}>
            <p>This deletes every ground, slot, team and booking now in the app (and payments recorded on those bookings), then loads <b>{file?.name}</b>.</p>
            <p className="mt-2">App users, settings, payment accounts and promoters stay. This can't be undone.</p>
          </ConfirmSheet>
        )}
      </Page>
    </>
  );
}
