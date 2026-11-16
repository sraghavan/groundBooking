import { useMemo, useState } from 'react';
import type { Team } from '../api';
import { cx, fmtMobile, pocLine } from '../lib';

/**
 * A team on a booking: an existing team (teamId), or a new one by name.
 * Team names are NOT unique, so a typed name is never linked automatically;
 * the user picks the right team (shown with its POC + mobile) or confirms a new team.
 */
export type TeamRef = {
  teamId?: string; teamName: string;
  newTeam?: boolean;                       // confirmed: create a new team even though the name exists
  contactName?: string; contactMobile?: string; // first POC for a new team
};

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
const digits = (s: string) => s.replace(/\D/g, '');

export function TeamPicker({ value, onChange, teams, placeholder, exclude }: {
  value: TeamRef; onChange: (v: TeamRef) => void; teams: Team[]; placeholder?: string; exclude?: string[];
}) {
  const [open, setOpen] = useState(false);
  const q = key(value.teamName);
  const qd = digits(value.teamName);
  const avail = useMemo(() => teams.filter((t) => !exclude?.includes(t.id)), [teams, exclude]);
  const matches = useMemo(() => {
    if (!q) return [];
    return avail.filter((t) => key(t.name).includes(q)
      || t.contacts.some((c) => c.active && (key(c.name).includes(q) || (qd.length >= 4 && digits(c.mobile).includes(qd)))))
      .sort((a, b) => Number(key(b.name) === q) - Number(key(a.name) === q) || b.bookingCount - a.bookingCount)
      .slice(0, 8);
  }, [avail, q, qd]);
  const sameName = teams.filter((t) => key(t.name) === q);
  const linked = value.teamId ? teams.find((t) => t.id === value.teamId) : undefined;
  const isNew = !value.teamId && !!q;
  const needsChoice = isNew && sameName.length > 0 && !value.newTeam;

  return (
    <div className="space-y-2">
      <div className="relative">
        <input
          value={value.teamName}
          onChange={(e) => { onChange({ teamName: e.target.value }); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={placeholder ?? 'Team, contact name or mobile'}
          autoComplete="off"
          className={cx('h-12 w-full rounded-xl border bg-white px-3 pr-20 outline-none focus:ring-2 focus:ring-pitch/15',
            value.teamId ? 'border-pitch/40' : needsChoice ? 'border-partial' : 'border-line focus:border-pitch')}
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-bold uppercase tracking-wide">
          {value.teamId ? <span className="text-free">✓ Saved</span> : needsChoice ? <span className="text-partial">Choose</span> : isNew ? <span className="text-partial">New</span> : null}
        </span>
        {open && !value.teamId && matches.length > 0 && (
          <ul className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-line bg-white py-1 shadow-lg">
            {matches.map((t) => (
              <li key={t.id}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange({ teamId: t.id, teamName: t.name }); setOpen(false); }}
                  className="block w-full px-3 py-2 text-left active:bg-paper">
                  <span className="block font-semibold">{t.name}</span>
                  <span className={cx('block text-xs tabular', t.poc ? 'text-muted' : 'text-partial')}>{pocLine(t.poc?.name, t.poc?.mobile)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {linked && (
        <p className="px-1 text-xs text-muted">
          POC: {linked.poc ? <><span className="font-semibold text-ink">{linked.poc.name}</span> · <a className="tabular underline" href={`tel:${linked.poc.mobile}`}>{fmtMobile(linked.poc.mobile)}</a></> : <span className="text-partial">no contact yet</span>}
        </p>
      )}

      {needsChoice && (
        <div className="rounded-xl bg-partial-bg px-3 py-2.5 text-xs">
          <p className="font-semibold text-partial">
            {sameName.length === 1 ? 'A team' : `${sameName.length} teams`} already called “{sameName[0].name}”. Tap the right one above, or:
          </p>
          <button type="button" className="mt-1.5 font-bold text-pitch underline" onClick={() => onChange({ ...value, newTeam: true })}>
            This is a different team. Add it as new
          </button>
        </div>
      )}

      {isNew && !needsChoice && (
        <div className="grid grid-cols-2 gap-2">
          <input value={value.contactName ?? ''} onChange={(e) => onChange({ ...value, contactName: e.target.value })} placeholder="POC name"
            className="h-11 rounded-xl border border-line bg-white px-3 text-sm outline-none focus:border-pitch" />
          <input value={value.contactMobile ?? ''} onChange={(e) => onChange({ ...value, contactMobile: e.target.value })} placeholder="Mobile" inputMode="tel"
            className="h-11 rounded-xl border border-line bg-white px-3 text-sm tabular outline-none focus:border-pitch" />
          <p className="col-span-2 px-1 text-[11px] text-muted">New team. Add its POC so you can tell it apart and send reminders.</p>
        </div>
      )}
    </div>
  );
}
