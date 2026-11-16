import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useMe } from '../../hooks';
import { Button, Card, ErrorNote, Field, Input, Page, PageHeader, Textarea } from '../../components/ui';

const DEFAULT_TEMPLATE = 'Hi {contact}, this is a reminder from {org}. {team} has {amount} pending:\n{details}\n{upi}Thank you!';

export function SettingsPage() {
  const me = useMe();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', reminderTemplate: '' });
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (me.data) setF({ name: me.data.org.name, reminderTemplate: me.data.org.settings.reminderTemplate || DEFAULT_TEMPLATE });
  }, [me.data]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    try {
      await api('/settings', { method: 'PATCH', body: { name: f.name, settings: { reminderTemplate: f.reminderTemplate } } });
      await qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['dues'] });
      setSaved(true);
    } catch (err) { setError(err); }
  }

  return (
    <>
      <PageHeader title="Settings" back="/more" />
      <Page>
        <form onSubmit={submit} className="space-y-5">
          <Card className="space-y-4 p-4">
            <Field label="Business name"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <p className="text-sm text-muted">UPI IDs and QR codes are under <Link to="/admin/accounts" className="font-semibold text-pitch">Payment accounts</Link>.</p>
          </Card>
          <Card className="space-y-3 p-4">
            <Field label="WhatsApp reminder message" hint={<>Placeholders: {'{contact} {team} {amount} {details} {upi} {org}'}. {'{upi}'} becomes the chosen account's UPI ID and QR link.</>}>
              <Textarea rows={6} value={f.reminderTemplate} onChange={(e) => setF({ ...f, reminderTemplate: e.target.value })} />
            </Field>
            <button type="button" className="text-sm font-semibold text-pitch" onClick={() => setF({ ...f, reminderTemplate: DEFAULT_TEMPLATE })}>Reset to default</button>
          </Card>
          <ErrorNote error={error} />
          {saved && <p className="text-sm font-semibold text-free">✓ Saved</p>}
          <Button className="w-full">Save settings</Button>
        </form>
      </Page>
    </>
  );
}
