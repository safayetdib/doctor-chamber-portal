'use client';

import { useState, useSyncExternalStore } from 'react';
import { accountSchema, challengeResponseSchema } from '@practice/contracts';
import { emptyWrite, field, write, type Output } from './api';
import { useAction } from './hooks';
import { Feedback } from './ui';
import { CodeField, PatientFields, SmsAvailability, type Account } from './account-settings';

type Mode = 'login' | 'setup' | 'signup' | 'phone' | 'recovery' | 'operator';
const headings: Record<Mode, string> = {
  login: 'Sign in', setup: 'Activate your account', signup: 'Create a patient account',
  phone: 'Sign in with a code', recovery: 'Reset your password', operator: 'Use a recovery link'
};
const readHash = () => window.location.hash;
function subscribeHash(callback: () => void) {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
}

function PasswordSignIn({ onAccount }: { onAccount: (account: Account) => void }) {
  const action = useAction();
  return <>
    <form className="fields" onSubmit={(event) => action.form(event, async (data) => {
      onAccount(await write('/auth/login', accountSchema, 'POST', {
        loginId: field(data, 'loginId'), password: String(data.get('password') ?? '')
      }));
    })}>
      <fieldset disabled={action.busy}>
        <label>Login ID<input name="loginId" autoComplete="username" required /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" maxLength={128} required /></label>
        <button>{action.busy ? 'Signing in…' : 'Sign in'}</button>
      </fieldset>
    </form>
    <Feedback error={action.error} />
  </>;
}

function LinkForm({ purpose, token, onAccount, onReset }: {
  purpose: 'setup' | 'operator'; token: string; onAccount: (account: Account) => void; onReset: () => void;
}) {
  const action = useAction();
  return <>
    <form className="fields" onSubmit={(event) => action.form(event, async (data) => {
      const body = { token: field(data, 'token'), password: String(data.get('password') ?? '') };
      if (purpose === 'setup') {
        const account = await write('/auth/setup', accountSchema, 'POST', body);
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
        onAccount(account);
      } else {
        await emptyWrite('/auth/recovery/operator/complete', 'POST', body);
        onReset();
      }
    })}>
      <fieldset disabled={action.busy}>
        <label>{purpose === 'setup' ? 'Setup token' : 'Recovery token'}<input name="token"
          defaultValue={token} autoComplete="off" required /></label>
        <label>{purpose === 'setup' ? 'Password' : 'New password'}<input name="password" type="password"
          autoComplete="new-password" minLength={12} maxLength={128} required /></label>
        <button>{action.busy ? 'Saving…' : purpose === 'setup' ? 'Set password and sign in' : 'Reset password'}</button>
      </fieldset>
    </form>
    <Feedback error={action.error} />
  </>;
}

function OtpFlow({ purpose, onAccount, onReset }: {
  purpose: 'signup' | 'phone' | 'recovery'; onAccount: (account: Account) => void; onReset: () => void;
}) {
  const [challenge, setChallenge] = useState<Output<typeof challengeResponseSchema>>();
  const [startBody, setStartBody] = useState<object>();
  const action = useAction();
  const routes = { signup: '/auth/signup', phone: '/auth/phone-login', recovery: '/auth/recovery' };
  async function start(body: object) {
    const result = await write(routes[purpose] + '/start', challengeResponseSchema, 'POST', body);
    setStartBody(body);
    setChallenge(result);
  }
  return <>
    <SmsAvailability />
    {purpose === 'recovery' && <p className="quiet">If you have no authorized sign-in phone, contact your practice or administrator for a private recovery link.</p>}
    {!challenge ? <form className="fields" onSubmit={(event) => action.form(event, async (data) => {
      await start(purpose === 'signup' ? {
        name: field(data, 'name'), contactPhone: field(data, 'contactPhone'),
        birthDate: field(data, 'birthDate') || undefined, gender: field(data, 'gender') || undefined,
        address: field(data, 'address') || undefined
      } : { loginId: field(data, 'loginId') });
    })}>
      <fieldset disabled={action.busy}>
        {purpose === 'signup' ? <PatientFields /> : <>
          <p className="quiet">Enter your login ID. If this account has an authorized sign-in phone, a code will be sent to it.</p>
          <label>Login ID<input name="loginId" autoComplete="username" required /></label>
        </>}
        <button>{action.busy ? 'Requesting code…' : 'Send verification code'}</button>
      </fieldset>
    </form> : <>
      <p className="quiet">{purpose === 'signup' ? 'Enter the code for the contact phone you provided.'
        : 'If your account has an authorized sign-in phone, enter the code sent to it.'}</p>
      <form key={challenge.challengeId} className="fields" onSubmit={(event) => action.form(event, async (data) => {
        const body = { challengeId: challenge.challengeId, code: field(data, 'code'),
          ...(purpose !== 'phone' && { password: String(data.get('password') ?? '') }) };
        if (purpose === 'recovery') {
          await emptyWrite(routes[purpose] + '/complete', 'POST', body);
          onReset();
        } else {
          onAccount(await write(routes[purpose] + '/complete', accountSchema, 'POST', body));
        }
      })}>
        <fieldset disabled={action.busy}>
          <CodeField />
          {purpose !== 'phone' && <label>New password<input name="password" type="password"
            autoComplete="new-password" minLength={12} maxLength={128} required /></label>}
          <button>{action.busy ? 'Verifying…' : purpose === 'signup' ? 'Verify and create account'
            : purpose === 'phone' ? 'Verify and sign in' : 'Reset password'}</button>
        </fieldset>
      </form>
      <div className="inline auth-links">
        <button className="text-button" disabled={action.busy} onClick={() => void action.run(async () => { await start(startBody!); })}>Send a new code</button>
        <button className="text-button" disabled={action.busy} onClick={() => setChallenge(undefined)}>Change details</button>
      </div>
    </>}
    <Feedback error={action.error} />
  </>;
}

export function AuthScreens({ onAccount }: { onAccount: (account: Account) => void }) {
  const hash = useSyncExternalStore(subscribeHash, readHash, () => '');
  const [chosenMode, setMode] = useState<Mode>();
  const [notice, setNotice] = useState('');
  const mode = hash.startsWith('#setup=') ? 'setup' : hash.startsWith('#recovery=') ? 'operator' : chosenMode ?? 'login';
  const token = hash.startsWith('#setup=') ? hash.slice(7) : hash.startsWith('#recovery=') ? hash.slice(10) : '';
  function changeMode(next: Mode) {
    setMode(next);
    setNotice('');
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  function resetComplete() {
    changeMode('login');
    setNotice('Password updated. Sign in with your login ID and new password.');
  }
  return <div className="auth-grid">
    <div className="auth-intro">
      <h1>Chamber queue</h1>
      <p>Book a consultation, follow your turn, or manage your practice’s sessions.</p>
      <div className="auth-rule" />
      <p className="auth-note">Keep your assigned login ID. Each family member has a separate account, including when sharing a contact phone.</p>
    </div>
    <section className="surface auth-form" key={mode}>
      <h2>{headings[mode]}</h2>
      <Feedback notice={notice} />
      {mode === 'login' && <PasswordSignIn onAccount={onAccount} />}
      {(mode === 'setup' || mode === 'operator') && <LinkForm key={token} purpose={mode} token={token} onAccount={onAccount} onReset={resetComplete} />}
      {(mode === 'signup' || mode === 'phone' || mode === 'recovery') &&
        <OtpFlow purpose={mode} onAccount={onAccount} onReset={resetComplete} />}
      <nav className="auth-links" aria-label="Sign-in options">
        {mode === 'login' ? <>
          <button className="text-button" onClick={() => changeMode('signup')}>Create a patient account</button>
          <button className="text-button" onClick={() => changeMode('phone')}>Sign in with a code</button>
          <button className="text-button" onClick={() => changeMode('recovery')}>Forgot password?</button>
          <button className="text-button" onClick={() => changeMode('setup')}>Use a setup token</button>
          <button className="text-button" onClick={() => changeMode('operator')}>Use a recovery token</button>
        </> : <button className="text-button" onClick={() => changeMode('login')}>Back to sign in</button>}
      </nav>
    </section>
  </div>;
}
