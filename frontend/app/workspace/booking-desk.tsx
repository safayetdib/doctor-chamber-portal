'use client';

import { useState } from 'react';
import { bookingSummarySchema, patientRegistrationSchema, setupInvitationSchema } from '@practice/contracts';
import { ApiError, field, localTime, write, type Output } from './api';
import { useAction } from './hooks';
import { Feedback, SetupInvitation } from './ui';

type BookingInput = { loginId: string; special: boolean; reason: string };
type Confirmation = NonNullable<ApiError['details']>;

export function BookingDesk({ sessionId, revision, refresh }: {
  sessionId: string; revision: number; refresh: () => void;
}) {
  const [loginId, setLoginId] = useState('');
  const [special, setSpecial] = useState(false);
  const [options, setOptions] = useState<{ input: BookingInput; confirmation: Confirmation } | null>(null);
  const [invitation, setInvitation] = useState<Output<typeof setupInvitationSchema>>();
  const booking = useAction();
  const registration = useAction();

  async function reserve(input: BookingInput, confirmation?: Confirmation) {
    setOptions(null);
    const route = input.special ? '/practice/sessions/' + sessionId + '/queue/special-bookings' : '/sessions/' + sessionId + '/bookings';
    const body = input.special
      ? { patientLoginId: input.loginId, expectedRevision: confirmation?.expectedRevision ?? revision,
          priorityReason: input.reason || undefined, acknowledged: confirmation?.warnings }
      : { patientLoginId: input.loginId, confirmation: confirmation && {
          expectedRevision: confirmation.expectedRevision, acknowledged: confirmation.warnings
        } };
    try {
      const result = await write(route, bookingSummarySchema, 'POST', body, true);
      setLoginId('');
      setSpecial(false);
      refresh();
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.details && error.code === 'OVERTIME_CONFIRMATION_REQUIRED') {
        setOptions({ input, confirmation: error.details });
        return;
      }
      if (error instanceof ApiError && error.code === 'STALE_QUEUE') refresh();
      throw error;
    }
  }

  return <section className="surface">
    <h2>Book a patient</h2>
    <form className="fields" onSubmit={(event) => booking.form(event, async (data, form) => {
      if (await reserve({ loginId, special, reason: field(data, 'reason') })) form.reset();
    })}>
      <label>Patient login ID<input name="patientLoginId" value={loginId} onChange={(event) => setLoginId(event.target.value)} required /></label>
      <label className="check"><input type="checkbox" checked={special} onChange={(event) => setSpecial(event.target.checked)} /> Special slot</label>
      {special && <label>Priority reason <span className="optional">optional</span><input name="reason" maxLength={300} /></label>}
      <button disabled={booking.busy}>Add booking</button>
    </form>
    <Feedback error={booking.error} />
    {options && <div className="confirmation">
      <strong>Confirm booking for {options.input.loginId}</strong>
      <ul>
        {options.confirmation.warnings.includes('capacity') && <li>This session is at capacity.</li>}
        {options.confirmation.warnings.includes('overtime') &&
          <li>Estimated finish is {localTime(options.confirmation.projectedFinishAt)} Dhaka time, after the scheduled end.</li>}
      </ul>
      <div className="inline">
        <button disabled={booking.busy} onClick={() => void booking.run(async () => { await reserve(options.input, options.confirmation); })}>
          Confirm booking
        </button>
        <button className="secondary" onClick={() => setOptions(null)}>Go back</button>
      </div>
    </div>}
    <details className="subsection">
      <summary>Register a new patient</summary>
      <form className="fields" onSubmit={(event) => registration.form(event, async (data, form) => {
        const result = await write('/patients', patientRegistrationSchema, 'POST', {
          name: field(data, 'name'), contactPhone: field(data, 'phone')
        });
        setLoginId(result.patient.loginId);
        setInvitation(result.invitation);
        form.reset();
      }, 'Patient registered. The login ID is ready to book.')}>
        <label>Patient name<input name="name" required /></label>
        <label>Contact phone<input name="phone" type="tel" required /></label>
        <button className="secondary" disabled={registration.busy}>Register patient</button>
      </form>
      <Feedback error={registration.error} notice={registration.notice} />
      {invitation && <SetupInvitation key={invitation.setupToken} invitation={invitation} />}
    </details>
  </section>;
}
