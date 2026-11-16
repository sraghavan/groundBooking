import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, auth } from '../api';
import { Button, ErrorNote, Field, Input } from '../components/ui';

export function LoginPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['auth-status'], queryFn: () => api<{ needsSetup: boolean }>('/auth/status') });
  const setup = status.data?.needsSetup;
  const [f, setF] = useState({ orgName: '', name: '', email: '', password: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ token: string }>(setup ? '/auth/signup' : '/auth/login', { body: setup ? f : { email: f.email, password: f.password } });
      auth.set(res.token);
      qc.clear();
      nav('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <div className="pt-safe min-h-dvh bg-pitch">
      <div className="mx-auto max-w-sm px-6 pb-10 pt-16">
        <img src="/icon.svg" alt="" className="h-14 w-14 rounded-2xl ring-1 ring-white/20" />
        <h1 className="mt-6 font-display text-4xl font-bold leading-tight text-white">Ground<br />Booking</h1>
        <p className="mt-2 text-white/70">{setup ? 'Set up your business to get started.' : 'Sign in to manage grounds, slots and dues.'}</p>
        <form onSubmit={submit} className="mt-8 space-y-4 rounded-3xl bg-paper p-5">
          {setup && (
            <>
              <Field label="Business name"><Input required value={f.orgName} onChange={set('orgName')} placeholder="e.g. Chennai Cricket Grounds" /></Field>
              <Field label="Your name"><Input required value={f.name} onChange={set('name')} autoComplete="name" /></Field>
            </>
          )}
          <Field label="Email"><Input required type="email" value={f.email} onChange={set('email')} autoComplete="email" /></Field>
          <Field label="Password" hint={setup ? 'At least 8 characters' : undefined}>
            <Input required type="password" minLength={setup ? 8 : undefined} value={f.password} onChange={set('password')} autoComplete={setup ? 'new-password' : 'current-password'} />
          </Field>
          <ErrorNote error={error} />
          <Button className="w-full" disabled={busy || status.isLoading}>{busy ? 'Please wait…' : setup ? 'Create account' : 'Sign in'}</Button>
        </form>
      </div>
    </div>
  );
}
