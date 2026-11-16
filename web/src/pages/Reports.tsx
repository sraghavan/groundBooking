import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, downloadFile, type Report } from '../api';
import { useCities, useGrounds } from '../hooks';
import { addDays, endOfMonth, fmtDate, inr, startOfMonth, startOfQuarter, startOfWeek, startOfYear, todayISO } from '../lib';
import { Button, Card, Chip, Empty, ErrorNote, Field, Input, Page, PageHeader, Segmented, Select, Spinner } from '../components/ui';

type Preset = 'week' | 'month' | 'quarter' | 'year' | 'custom';
type Period = 'all' | 'day' | 'week' | 'month' | 'quarter' | 'year';
type GroupBy = 'none' | 'ground' | 'city';

function presetRange(p: Preset, today: string): [string, string] {
  switch (p) {
    case 'week': return [startOfWeek(today), addDays(startOfWeek(today), 6)];
    case 'month': return [startOfMonth(today), endOfMonth(today)];
    case 'quarter': { const s = startOfQuarter(today); const [y, m] = s.split('-').map(Number); return [s, endOfMonth(`${y}-${String(m + 2).padStart(2, '0')}-01`)]; }
    case 'year': return [startOfYear(today), today.slice(0, 4) + '-12-31'];
    default: return [startOfMonth(today), today];
  }
}
const defaultPeriod: Record<Preset, Period> = { week: 'day', month: 'week', quarter: 'month', year: 'quarter', custom: 'all' };

function periodLabel(p: string) {
  if (p === 'All') return 'Total';
  if (p.startsWith('W ')) return `Week of ${fmtDate(p.slice(2))}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return fmtDate(p, { weekday: 'short', day: 'numeric', month: 'short' });
  if (/^\d{4}-\d{2}$/.test(p)) return fmtDate(p + '-01', { month: 'long', year: 'numeric' });
  if (/Q\d$/.test(p)) return p.replace('-', ' ');
  return p;
}

export function ReportsPage() {
  const today = todayISO();
  const [preset, setPreset] = useState<Preset>('month');
  const [custom, setCustom] = useState<[string, string]>(presetRange('month', today));
  const [period, setPeriod] = useState<Period>('week');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [scope, setScope] = useState(''); // '' | 'g:<id>' | 'c:<id>'
  const grounds = useGrounds();
  const cities = useCities();

  const [from, to] = preset === 'custom' ? custom : presetRange(preset, today);
  const qs = new URLSearchParams({ from, to, period, groupBy });
  if (scope.startsWith('g:')) qs.set('groundId', scope.slice(2));
  if (scope.startsWith('c:')) qs.set('cityId', scope.slice(2));

  const q = useQuery({ queryKey: ['report', qs.toString()], queryFn: () => api<Report>(`/reports?${qs}`), enabled: from <= to });

  const byPeriod = useMemo(() => {
    const m = new Map<string, Report['rows']>();
    q.data?.rows.forEach((r) => m.set(r.period, [...(m.get(r.period) ?? []), r]));
    return [...m.entries()].reverse();
  }, [q.data]);

  const choosePreset = (p: Preset) => { setPreset(p); setPeriod(defaultPeriod[p]); };

  // Offline workbook for the same range and grounds: calendars per ground, bookings, payments, dues, teams.
  const [exporting, setExporting] = useState(false);
  async function exportExcel() {
    const xs = new URLSearchParams({ from, to });
    if (scope.startsWith('g:')) xs.set('groundId', scope.slice(2));
    if (scope.startsWith('c:')) xs.set('cityId', scope.slice(2));
    setExporting(true);
    try { await downloadFile(`/export/xlsx?${xs}`, `bookings_${from}_${to}.xlsx`); } finally { setExporting(false); }
  }
  const t = q.data?.totals;

  return (
    <>
      <PageHeader title="Reports" action={
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={!q.data} onClick={() => downloadFile(`/reports/csv?${qs}`, `report_${from}_${to}.csv`)}>CSV</Button>
          <Button size="sm" disabled={from > to || exporting} onClick={exportExcel}>{exporting ? '…' : 'Excel'}</Button>
        </div>
      } sub={
        <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
          {(['week', 'month', 'quarter', 'year', 'custom'] as Preset[]).map((p) => (
            <Chip key={p} active={preset === p} onClick={() => choosePreset(p)}>{{ week: 'This week', month: 'This month', quarter: 'This quarter', year: 'This year', custom: 'Date range' }[p]}</Chip>
          ))}
        </div>
      } />
      <Page>
        <div className="space-y-3">
          {preset === 'custom' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="From"><Input type="date" value={custom[0]} onChange={(e) => setCustom([e.target.value, custom[1]])} /></Field>
              <Field label="To"><Input type="date" value={custom[1]} onChange={(e) => setCustom([custom[0], e.target.value])} /></Field>
            </div>
          )}
          <Field label="Grounds">
            <Select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">All grounds</option>
              {(cities.data?.length ?? 0) > 0 && <optgroup label="City">{cities.data!.map((c) => <option key={c.id} value={`c:${c.id}`}>{c.name} (all grounds)</option>)}</optgroup>}
              <optgroup label="Ground">{grounds.data?.map((g) => <option key={g.id} value={`g:${g.id}`}>{g.name} · {g.cityName}</option>)}</optgroup>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Break down by">
              <Select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
                <option value="all">No breakdown</option><option value="day">Day</option><option value="week">Week</option>
                <option value="month">Month</option><option value="quarter">Quarter</option><option value="year">Year</option>
              </Select>
            </Field>
            <Field label="Group by">
              <Segmented value={groupBy} onChange={setGroupBy} options={[{ value: 'none', label: 'All' }, { value: 'ground', label: 'Ground' }, { value: 'city', label: 'City' }]} />
            </Field>
          </div>
        </div>

        <p className="mt-5 text-sm font-semibold text-muted">{fmtDate(from, { day: 'numeric', month: 'short', year: 'numeric' })} – {fmtDate(to, { day: 'numeric', month: 'short', year: 'numeric' })}</p>
        <ErrorNote error={q.error} />
        {q.isLoading ? <Spinner /> : t && (
          <>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <Stat label="Grounds booked" value={String(t.bookings)} sub={`${t.hours.toLocaleString('en-IN')} hours`} />
              <Stat label="Billed" value={inr(t.billed)} />
              <Stat label="Payments received" value={inr(t.received)} sub="cash in this period" tone="free" />
              <Stat label="Payments due" value={inr(t.due)} sub="unpaid, incl. upcoming" tone={t.due > 0 ? 'full' : undefined} />
            </div>

            {byPeriod.length === 0 ? <div className="mt-4"><Empty title="No bookings in this range" /></div> : (
              <div className="mt-5 space-y-3">
                {byPeriod.map(([p, rows]) => (
                  <Card key={p} className="overflow-hidden">
                    <div className="border-b border-line bg-paper/60 px-4 py-2 text-sm font-bold">{periodLabel(p)}</div>
                    <table className="w-full table-fixed text-sm tabular">
                      <thead>
                        <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                          <th className="w-[38%] px-4 py-2 font-semibold">{groupBy === 'none' ? '' : groupBy === 'city' ? 'City' : 'Ground'}</th>
                          <th className="px-2 py-2 text-right font-semibold">Bkgs</th>
                          <th className="px-2 py-2 text-right font-semibold">Received</th>
                          <th className="px-4 py-2 text-right font-semibold">Due</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {rows.map((r) => (
                          <tr key={r.groupId ?? 'all'}>
                            <td className="truncate px-4 py-2.5 font-semibold">{r.groupName}</td>
                            <td className="px-2 py-2.5 text-right">{r.bookings}</td>
                            <td className="px-2 py-2.5 text-right text-free">{inr(r.received)}</td>
                            <td className="px-4 py-2.5 text-right text-full">{r.due ? inr(r.due) : '–'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </Page>
    </>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'free' | 'full' }) {
  return (
    <Card className="p-3.5">
      <div className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular ${tone === 'free' ? 'text-free' : tone === 'full' ? 'text-full' : ''}`}>{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </Card>
  );
}
