import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { auth } from '../api';
import { useMe } from '../hooks';
import { Button, Card, ListLink, Page, PageHeader } from '../components/ui';

export function MorePage() {
  const me = useMe();
  const nav = useNavigate();
  const qc = useQueryClient();
  const owner = me.data?.user.role === 'owner';
  return (
    <>
      <PageHeader title="More" />
      <Page className="space-y-5">
        <Card className="p-4">
          <div className="font-bold">{me.data?.user.name}</div>
          <div className="text-sm text-muted">{me.data?.user.email} · {owner ? 'Owner' : 'Partner'}</div>
        </Card>
        <section>
          <h3 className="mb-2 px-1 text-xs font-bold uppercase tracking-wide text-muted">Setup</h3>
          <Card className="divide-y divide-line overflow-hidden">
            <ListLink to="/admin/grounds" title="Grounds & slots" sub="Cities, grounds, slot timings and default prices" />
            <ListLink to="/admin/teams" title="Teams & contacts" sub="Teams and their POCs" />
            <ListLink to="/admin/promoters" title="Promoters" sub="Rana, Ravinder… mobile and standard rates" />
            <ListLink to="/admin/pricing" title="Prices" sub="Event prices, special prices per team / ground / slot" />
            <ListLink to="/admin/accounts" title="Payment accounts" sub="UPI IDs and QR codes for reminders" />
          </Card>
        </section>
        {owner && (
          <section>
            <h3 className="mb-2 px-1 text-xs font-bold uppercase tracking-wide text-muted">Business</h3>
            <Card className="divide-y divide-line overflow-hidden">
              <ListLink to="/admin/partners" title="App users" sub="Who uses this app" />
              <ListLink to="/admin/settings" title="Settings" sub="Business name, reminder message" />
            </Card>
          </section>
        )}
        <Button variant="secondary" className="w-full" onClick={() => { auth.set(null); qc.clear(); nav('/login', { replace: true }); }}>Sign out</Button>
      </Page>
    </>
  );
}
