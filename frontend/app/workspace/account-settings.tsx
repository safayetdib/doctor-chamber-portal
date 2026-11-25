'use client';

import { useState } from 'react';
import { accountSchema, challengeResponseSchema } from '@practice/contracts';
import { emptyWrite, field, request, write, type Output } from './api';
import { useAction } from './hooks';
import { Feedback } from './ui';

export type Account = Output<typeof accountSchema>;

export function CodeField() {
  return <label>Verification code<input name="code" inputMode="numeric" autoComplete="one-time-code"
    pattern="[0-9]{6}" minLength={6} maxLength={6} required /></label>;
}

export function PatientFields({ account }: { account?: Account }) {
  return <>
    <label>Full name<input name="name" autoComplete="name" defaultValue={account?.name} maxLength={120} required /></label>
    <label>Contact phone<input name="contactPhone" type="tel" autoComplete="tel" defaultValue={account?.contactPhone}
      placeholder="+880…" required /></label>
    <label>Date of birth <span className="optional">optional</span><input name="birthDate" type="date"
      defaultValue={account?.patientDetails?.birthDate} autoComplete="bday" /></label>
    <label>Gender <span className="optional">optional</span><input name="gender" maxLength={40}
      defaultValue={account?.patientDetails?.gender} /></label>
    <label>Address <span className="optional">optional</span><textarea name="address" rows={3} maxLength={400}
      autoComplete="street-address" defaultValue={account?.patientDetails?.address} /></label>
  </>;
}

export function SmsAvailability() {
  return <p className="quiet sms-availability">SMS delivery is not connected in this prototype.</p>;
}

function PhoneLoginSettings({ account, onAccount }: { account: Account; onAccount: (account: Account) => void }) {
  const [challenge, setChallenge] = useState<Output<typeof challengeResponseSchema>>();
  const [phone, setPhone] = useState('');
  const [sentPhone, setSentPhone] = useState('');
  const action = useAction();

  async function refreshAccount() {
    onAccount(await request('/auth/me', accountSchema));
  }

  return <section className="surface">
    <h2>Phone sign-in</h2>
    <p className="quiet">{account.phoneLoginEnabled ? 'Enabled for your account.' : 'Disabled for your account.'}
      {' '}Your login ID is always required. Manage your authorized sign-in phone separately from your contact details.</p>
    <Feedback error={action.error} notice={action.notice} />
    {account.phoneLoginEnabled && <button className="secondary" disabled={action.busy} onClick={() => void action.run(async () => {
      await emptyWrite('/auth/phone-grant', 'DELETE');
      setChallenge(undefined);
      await refreshAccount();
    }, 'Phone sign-in disabled.')}>Disable phone sign-in</button>}
    <SmsAvailability />
    {!challenge ? <form className="fields" onSubmit={(event) => action.form(event, async (data, form) => {
      try {
        const result = await write('/auth/phone-grant/start', challengeResponseSchema, 'POST', {
          phone: field(data, 'phone'), password: String(data.get('password') ?? '')
        });
        setSentPhone(field(data, 'phone'));
        setChallenge(result);
      } finally {
        (form.elements.namedItem('password') as HTMLInputElement).value = '';
      }
    })}>
      <fieldset disabled={action.busy}>
        <label>Authorize a sign-in phone<input name="phone" type="tel" value={phone}
          onChange={(event) => setPhone(event.target.value)} required /></label>
        <label>Current password<input name="password" type="password" autoComplete="current-password" maxLength={128} required /></label>
        <button>{action.busy ? 'Requesting code…' : 'Send verification code'}</button>
      </fieldset>
    </form> : <>
      <p>Enter the code for {sentPhone}. Request a new code if it expires.</p>
      <form className="fields" key={challenge.challengeId} onSubmit={(event) => action.form(event, async (data) => {
        await emptyWrite('/auth/phone-grant/complete', 'POST', { challengeId: challenge.challengeId, code: field(data, 'code') });
        setChallenge(undefined);
        await refreshAccount();
      }, 'Phone sign-in enabled.')}>
        <fieldset disabled={action.busy}>
          <CodeField />
          <button>{action.busy ? 'Verifying…' : 'Verify sign-in phone'}</button>
        </fieldset>
      </form>
      <button className="text-button" disabled={action.busy} onClick={() => setChallenge(undefined)}>Request a new code</button>
    </>}
  </section>;
}

export function AccountSettings({ account, onAccount }: { account: Account; onAccount: (account: Account) => void }) {
  const action = useAction();
  return <>
    <div className="section-title"><h1>Your account</h1><p>Manage your details and sign-in options.</p></div>
    <div className="workspace-grid">
      <section className="surface">
        <h2>Patient profile</h2>
        <dl className="account-identifiers">
          <div><dt>Login ID</dt><dd>{account.loginId}</dd></div>
          <div><dt>Patient ID</dt><dd>{account.patientId}</dd></div>
          <div><dt>Contact phone</dt><dd>{account.contactPhoneVerified ? 'Verified' : 'Unverified'}</dd></div>
        </dl>
        <Feedback error={action.error} notice={action.notice} />
        <form className="fields" onSubmit={(event) => action.form(event, async (data) => {
          const updated = await write('/auth/me', accountSchema, 'PATCH', {
            name: field(data, 'name'), contactPhone: field(data, 'contactPhone'),
            birthDate: field(data, 'birthDate') || null, gender: field(data, 'gender') || null,
            address: field(data, 'address') || null
          });
          onAccount(updated);
        }, 'Profile saved.')}>
          <fieldset disabled={action.busy}>
            <PatientFields account={account} />
            <button>{action.busy ? 'Saving…' : 'Save profile'}</button>
          </fieldset>
        </form>
      </section>
      <PhoneLoginSettings account={account} onAccount={onAccount} />
    </div>
  </>;
}
