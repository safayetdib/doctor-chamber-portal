'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { accountSchema } from '@practice/contracts';
import { ApiError, emptyWrite, errorMessage, field, request, write, type Output } from './api';
import { useAction } from './hooks';
import { Feedback } from './ui';
import { Admin } from './admin';
import { Patient } from './patient';
import { Staff } from './staff';

type Account = Output<typeof accountSchema>;
const roleLabel = { patient: 'Patient', doctor: 'Doctor', assistant: 'Assistant', superuser: 'Administrator' };
const readHash = () => window.location.hash;
const emptyHash = () => '';
function subscribeHash(callback: () => void) {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
}

function SignIn({ onAccount }: { onAccount: (account: Account) => void }) {
  const hash = useSyncExternalStore(subscribeHash, readHash, emptyHash);
  const [mode, setMode] = useState<'login' | 'setup'>();
  const token = hash.startsWith('#setup=') ? hash.slice(7) : '';
  const setup = (mode ?? (token ? 'setup' : 'login')) === 'setup';
  const action = useAction();

  return <div className="auth-grid">
    <div className="auth-intro">
      <h1>Chamber queue</h1>
      <p>Book a consultation, follow your turn, or manage your practice’s sessions.</p>
      <div className="auth-rule" />
      <p className="auth-note">Use the login ID assigned to your account. If your practice sent a setup link, open it to choose a password.</p>
    </div>
    <section className="surface auth-form">
      <h2>{setup ? 'Activate your account' : 'Sign in'}</h2>
      <form key={setup ? token || 'setup' : 'login'} className="fields" onSubmit={(event) => action.form(event, async (data) => {
        const password = String(data.get('password') ?? '');
        const body = setup ? { token: field(data, 'token'), password } : { loginId: field(data, 'loginId'), password };
        const account = await write(setup ? '/auth/setup' : '/auth/login', accountSchema, 'POST', body);
        if (token) window.history.replaceState(null, '', window.location.pathname + window.location.search);
        onAccount(account);
      })}>
        {setup
          ? <label>Setup token<input name="token" defaultValue={token} autoComplete="off" required /></label>
          : <label>Login ID<input name="loginId" autoComplete="username" required /></label>}
        <label>Password<input name="password" type="password" autoComplete={setup ? 'new-password' : 'current-password'}
          minLength={setup ? 12 : undefined} maxLength={128} required /></label>
        <button disabled={action.busy}>{setup ? 'Set password and sign in' : 'Sign in'}</button>
      </form>
      <Feedback error={action.error} />
      <button className="text-button" type="button" onClick={() => setMode(setup ? 'login' : 'setup')}>
        {setup ? 'Back to sign in' : 'Use a setup token'}
      </button>
    </section>
  </div>;
}

export function Workspace() {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [startupError, setStartupError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const signOut = useAction();

  useEffect(() => {
    const controller = new AbortController();
    void request('/auth/me', accountSchema, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setAccount(result);
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      if (!(failure instanceof ApiError) || failure.status !== 401) setStartupError(errorMessage(failure));
      setAccount(null);
    });
    return () => controller.abort();
  }, [attempt]);

  return <>
    <header className="site-header">
      <div className="header-inner">
        <div className="wordmark"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>Chamber queue</div>
        {account && <div className="inline account-menu">
          <div><strong>{account.name}</strong><small>{roleLabel[account.role]} · {account.loginId}</small></div>
          <button className="secondary" disabled={signOut.busy} onClick={() => void signOut.run(async () => {
            await emptyWrite('/auth/logout', 'POST');
            setAccount(null);
          })}>Sign out</button>
        </div>}
      </div>
    </header>
    <main>
      <Feedback error={signOut.error || startupError} />
      {startupError && <button className="secondary" onClick={() => { setStartupError(''); setAttempt((n) => n + 1); }}>Retry connection</button>}
      {account === undefined && <p role="status">Checking your session…</p>}
      {account === null && <SignIn onAccount={(value) => { setStartupError(''); setAccount(value); }} />}
      {account?.role === 'superuser' && <Admin key={account.accountId} />}
      {account?.role === 'patient' && <Patient key={account.accountId} />}
      {(account?.role === 'doctor' || account?.role === 'assistant') &&
        <Staff key={account.accountId} doctor={account.role === 'doctor'} />}
    </main>
    <footer className="site-footer">Development workspace · use synthetic patient data</footer>
  </>;
}
