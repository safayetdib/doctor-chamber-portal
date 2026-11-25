'use client';

import { useEffect, useState } from 'react';
import { accountSchema } from '@practice/contracts';
import { ApiError, emptyWrite, errorMessage, request } from './api';
import { useAction } from './hooks';
import { Feedback } from './ui';
import { Admin } from './admin';
import { Patient } from './patient';
import { Staff } from './staff';
import { AuthScreens } from './auth';
import { AccountSettings, type Account } from './account-settings';

const roleLabel = { patient: 'Patient', doctor: 'Doctor', assistant: 'Assistant', superuser: 'Administrator' };

export function Workspace() {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [startupError, setStartupError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const signOut = useAction();
  const [patientView, setPatientView] = useState<'consultations' | 'account'>('consultations');

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
            setPatientView('consultations');
          })}>Sign out</button>
        </div>}
      </div>
    </header>
    <main>
      <Feedback error={signOut.error || startupError} />
      {startupError && <button className="secondary" onClick={() => { setStartupError(''); setAttempt((n) => n + 1); }}>Retry connection</button>}
      {account === undefined && <p role="status">Checking your session…</p>}
      {account === null && <AuthScreens onAccount={(value) => { setStartupError(''); setAccount(value); }} />}
      {account?.role === 'superuser' && <Admin key={account.accountId} />}
      {account?.role === 'patient' && <>
        <nav className="view-nav patient-nav" aria-label="Patient workspace">
          <button className="secondary" aria-pressed={patientView === 'consultations'} onClick={() => setPatientView('consultations')}>Consultations</button>
          <button className="secondary" aria-pressed={patientView === 'account'} onClick={() => setPatientView('account')}>Your account</button>
        </nav>
        {patientView === 'consultations' ? <Patient key={account.accountId} />
          : <AccountSettings account={account} onAccount={setAccount} />}
      </>}
      {(account?.role === 'doctor' || account?.role === 'assistant') &&
        <Staff key={account.accountId} doctor={account.role === 'doctor'} />}
    </main>
    <footer className="site-footer">Development workspace · use synthetic patient data</footer>
  </>;
}
