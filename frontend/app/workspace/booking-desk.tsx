'use client';

import { useState } from 'react';
import { bookingSummarySchema, patientIdentitySchema, patientRegistrationSchema, setupInvitationSchema } from '@practice/contracts';
import { ApiError, field, localTime, write, type Output } from './api';
import { useAction } from './hooks';
import { Feedback, SetupInvitation } from './ui';

type BookingInput = { loginId: string; special: boolean; reason: string };
type Confirmation = NonNullable<ApiError['details']>;

export function BookingDesk({ sessionId, revision, disabled, refresh }: {
  sessionId: string; revision: number; disabled: boolean; refresh: () => void;
}) {
  const [loginId, setLoginId] = useState('');
  const [special, setSpecial] = useState(false);
  const [options, setOptions] = useState<{ input: BookingInput; confirmation: Confirmation } | null>(null);
  const [invitation, setInvitation] = useState<Output<typeof setupInvitationSchema>>();
  const [patient, setPatient] = useState<Output<typeof patientIdentitySchema>>();
  const [receipt, setReceipt] = useState('');
  const booking = useAction();
  const lookup = useAction();
  const registration = useAction();
  const busy = disabled || booking.busy || lookup.busy || registration.busy;

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
      setReceipt('Booking confirmed. Serial ' + result.serialNumber + ' has been added to the queue.');
      setLoginId('');
      setPatient(undefined);
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
    <form className="fields" onSubmit={(event) => lookup.form(event, async () => {
      setPatient(undefined);
      setOptions(null);
      setReceipt('');
      const result = await write('/patients/lookup', patientIdentitySchema, 'POST', { loginId });
      setLoginId(result.loginId);
      setPatient(result);
    })}>
      <fieldset disabled={busy}>
        <label>Patient login ID<input name="patientLoginId" value={loginId} onChange={(event) => {
          setLoginId(event.target.value);
          setPatient(undefined);
          setOptions(null);
          setReceipt('');
        }} autoComplete="off" required aria-describedby="patient-lookup-help" /></label>
        <small id="patient-lookup-help">Enter the patient's assigned login ID to check their name before booking.</small>
        <button className="secondary">{lookup.busy ? 'Finding patient…' : 'Find patient'}</button>
      </fieldset>
    </form>
    <Feedback error={lookup.error} />
    {patient && <div className="patient-preview" role="status">
      <strong>{patient.name}</strong>
      <code>{patient.loginId}</code>
    </div>}
    <form className="fields" onSubmit={(event) => booking.form(event, async (data, form) => {
      if (!patient) return;
      setReceipt('');
      if (await reserve({ loginId: patient.loginId, special, reason: field(data, 'reason') })) form.reset();
    })}>
      <fieldset disabled={busy || !patient}>
        <label className="check"><input type="checkbox" checked={special} onChange={(event) => {
          setSpecial(event.target.checked); setOptions(null);
        }} /> Special slot</label>
        {special && <label>Priority reason <span className="optional">optional</span><input name="reason" maxLength={300} /></label>}
        <button>{booking.busy ? 'Adding booking…' : 'Add booking'}</button>
      </fieldset>
    </form>
    <Feedback error={booking.error} notice={receipt} />
    {options && <div className="confirmation">
      <strong>Confirm booking for {options.input.loginId}</strong>
      <ul>
        {options.confirmation.warnings.includes('capacity') && <li>This session is at capacity.</li>}
        {options.confirmation.warnings.includes('overtime') &&
          <li>Estimated finish is {localTime(options.confirmation.projectedFinishAt)} Dhaka time, after the scheduled end.</li>}
      </ul>
      <div className="inline">
        <button disabled={busy} onClick={() => void booking.run(async () => { await reserve(options.input, options.confirmation); })}>
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
        setPatient(result.patient);
        setOptions(null);
        setReceipt('');
        setInvitation(result.invitation);
        form.reset();
      }, 'Patient registered. The login ID is ready to book.')}>
        <fieldset disabled={busy}>
          <label>Patient name<input name="name" required /></label>
          <label>Contact phone<input name="phone" type="tel" required /></label>
          <button className="secondary">{registration.busy ? 'Registering patient…' : 'Register patient'}</button>
        </fieldset>
      </form>
      <Feedback error={registration.error} notice={registration.notice} />
      {invitation && <SetupInvitation key={invitation.setupToken} invitation={invitation} />}
    </details>
  </section>;
}
