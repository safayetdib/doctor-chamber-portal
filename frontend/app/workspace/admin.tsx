'use client';

import { useState } from 'react';
import { adminPracticePageSchema, doctorCreatedSchema, practiceSchema, setupInvitationSchema } from '@practice/contracts';
import { field, write, type Output } from './api';
import { useAction, useResource } from './hooks';
import { Badge, Empty, Feedback, SetupInvitation } from './ui';
import { AccountRecovery } from './account-recovery';

export function Admin() {
  const [after, setAfter] = useState<string | null>(null);
  const [view, setView] = useState<'practices' | 'recovery'>('practices');
  const practices = useResource(view === 'practices' ? '/admin/practice-accounts' + (after ? '?after=' + after : '') : null, adminPracticePageSchema);
  const [invitation, setInvitation] = useState<Output<typeof setupInvitationSchema>>();
  const action = useAction();

  return <>
    <div className="section-title"><h1>{view === 'practices' ? 'Practices' : 'Account recovery'}</h1>
      <p>{view === 'practices' ? 'Provision doctors and manage their access.' : 'Help a verified account holder choose a new password.'}</p>
      <nav className="view-nav" aria-label="Administrator workspace">
        <button className="secondary" aria-pressed={view === 'practices'} onClick={() => setView('practices')}>Practices</button>
        <button className="secondary" aria-pressed={view === 'recovery'} onClick={() => setView('recovery')}>Account recovery</button>
      </nav>
    </div>
    {view === 'recovery' ? <AccountRecovery /> : <div className="workspace-grid">
      <section className="surface">
        <div className="inline spread"><h2>Practice directory</h2><button className="secondary" onClick={practices.refresh}>Refresh</button></div>
        <Feedback error={practices.error} />
        {practices.loading && <Empty>Loading practices…</Empty>}
        {practices.data?.practices.length === 0 && <Empty>Create a practice to issue its doctor an invitation.</Empty>}
        {practices.data?.practices.map((practice) => <article className="list-row" key={practice.doctorId}>
          <div><strong>{practice.displayName}</strong> <Badge value={practice.status} /></div>
          <div className="doctor-account">
            <span>{practice.doctorAccount.name}</span>
            <small>{practice.doctorAccount.loginId}</small>
            <small>Doctor account <Badge value={practice.doctorAccount.status} /></small>
          </div>
          <div className="inline">
            {practice.doctorAccount.status === 'pending_setup' && <button className="secondary" disabled={action.busy} onClick={() => void action.run(async () => {
              setInvitation(await write('/admin/practices/' + practice.doctorId + '/setup', setupInvitationSchema, 'POST', {}));
            })}>Reissue setup</button>}
            <button className="secondary" disabled={action.busy} onClick={() => {
              const status = practice.status === 'active' ? 'disabled' : 'active';
              if (status === 'disabled' && !window.confirm('Disable this practice and close its upcoming sessions?')) return;
              void action.run(async () => {
                await write('/admin/practices/' + practice.doctorId + '/status', practiceSchema, 'PATCH', { status });
                practices.refresh();
              }, status === 'active' ? 'Practice enabled.' : 'Practice disabled.');
            }}>{practice.status === 'active' ? 'Disable' : 'Enable'}</button>
          </div>
        </article>)}
        <div className="inline">
          {after && <button className="secondary" onClick={() => setAfter(null)}>First page</button>}
          {practices.data?.nextCursor && <button className="secondary" onClick={() => setAfter(practices.data!.nextCursor)}>Next page</button>}
        </div>
      </section>
      <section className="surface">
        <h2>Create a practice</h2>
        <form className="fields" onSubmit={(event) => action.form(event, async (data, form) => {
          const result = await write('/admin/practices', doctorCreatedSchema, 'POST', {
            name: field(data, 'name'), displayName: field(data, 'displayName'), contactPhone: field(data, 'contactPhone'),
            specialty: field(data, 'specialty') || undefined
          });
          setInvitation(result.invitation);
          form.reset();
          setAfter(null);
          practices.refresh();
        })}>
          <label>Doctor name<input name="name" autoComplete="off" required /></label>
          <label>Public practice name<input name="displayName" required /></label>
          <label>Contact phone<input name="contactPhone" type="tel" placeholder="+880…" required /></label>
          <label>Specialty <span className="optional">optional</span><input name="specialty" /></label>
          <button disabled={action.busy}>Create and invite doctor</button>
        </form>
        <Feedback error={action.error} notice={action.notice} />
        {invitation && <SetupInvitation key={invitation.setupToken} invitation={invitation} />}
      </section>
    </div>}
  </>;
}
