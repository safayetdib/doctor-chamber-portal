'use client';

import { useState } from 'react';
import { operatorRecoveryResponseSchema } from '@practice/contracts';
import { field, localDay, localTime, write, type Output } from './api';
import { useAction } from './hooks';
import { Feedback } from './ui';

export function AccountRecovery() {
  const action = useAction();
  const [invitation, setInvitation] = useState<(Output<typeof operatorRecoveryResponseSchema> & { loginId: string; caseReference: string })>();
  const [copied, setCopied] = useState(false);
  const link = invitation ? window.location.origin + '/#recovery=' + invitation.recoveryToken : '';
  return <div className="workspace-grid">
    <section className="surface">
      <h2>Issue a recovery link</h2>
      <p className="quiet">Use this for an activated doctor, assistant or patient account without an authorized sign-in phone.
        Complete identity verification through your established support process and record its case reference.</p>
      <Feedback error={action.error} />
      <form className="fields" onSubmit={(event) => action.form(event, async (data, form) => {
        setInvitation(undefined);
        setCopied(false);
        const loginId = field(data, 'loginId');
        const caseReference = field(data, 'caseReference');
        try {
          const result = await write('/admin/account-recovery', operatorRecoveryResponseSchema, 'POST', {
            loginId, caseReference, password: String(data.get('password') ?? '')
          });
          setInvitation({ ...result, loginId, caseReference });
        } finally {
          (form.elements.namedItem('password') as HTMLInputElement).value = '';
        }
      })}>
        <fieldset disabled={action.busy}>
          <label>Account login ID<input name="loginId" autoComplete="off" required /></label>
          <label>Verification case reference<input name="caseReference" pattern="CASE-[A-Z0-9]{6,24}"
            placeholder="CASE-ABC123" aria-describedby="case-help" required /></label>
          <small id="case-help">Use CASE- followed by 6–24 uppercase letters or digits. Keep identity-verification evidence in the support case.</small>
          <label>Your administrator password<input name="password" type="password" autoComplete="current-password"
            minLength={12} maxLength={128} required /></label>
          <label className="check"><input type="checkbox" required /> I have verified this account holder through the recorded case.</label>
          <button>{action.busy ? 'Issuing recovery link…' : 'Issue recovery link'}</button>
        </fieldset>
      </form>
    </section>
    <section className="surface">
      <h2>Private recovery invitation</h2>
      {invitation ? <div className="invitation">
        <p>Login ID <strong>{invitation.loginId}</strong></p>
        <p>Case {invitation.caseReference}</p>
        <p>Expires {localDay(invitation.expiresAt)} at {localTime(invitation.expiresAt)} Dhaka time.</p>
        <label>Private recovery link<input readOnly value={link} autoComplete="off"
          onFocus={(event) => event.currentTarget.select()} /></label>
        <div className="inline">
          <button className="secondary" onClick={() => {
            void navigator.clipboard.writeText(link).then(() => setCopied(true)).catch(() => setCopied(false));
          }}>{copied ? 'Copied' : 'Copy recovery link'}</button>
          <button className="secondary" onClick={() => setInvitation(undefined)}>Hide recovery link</button>
        </div>
      </div> : <p className="empty">The link will appear here after verification and reauthentication.</p>}
      <p className="quiet">Send it through the privately verified channel. A replacement link invalidates the previous link.
        Completing recovery revokes the account's existing sessions.</p>
    </section>
  </div>;
}
