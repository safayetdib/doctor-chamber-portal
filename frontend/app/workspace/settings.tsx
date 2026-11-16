'use client';

import { useState } from 'react';
import {
  assistantAssignmentSchema, assistantInvitedSchema, chamberSchema, referenceScheduleSchema, setupInvitationSchema
} from '@practice/contracts';
import { emptyWrite, field, write, type Output } from './api';
import { useAction, useResource } from './hooks';
import { Badge, Empty, Feedback, SetupInvitation } from './ui';

const chamberResponse = chamberSchema.nullable();
const referenceResponse = referenceScheduleSchema.nullable();
const assistantResponse = assistantAssignmentSchema.nullable();
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parseIntervals(value: string) {
  if (!value.trim()) return [];
  return value.split(',').map((interval) => {
    const match = /^(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})$/.exec(interval.trim());
    if (!match) throw new Error('Enter hours as HH:MM-HH:MM, separated by commas.');
    return { startTime: match[1], endTime: match[2] };
  });
}

function intervalsText(intervals: ReadonlyArray<{ startTime: string; endTime: string }>) {
  return intervals.map((value) => value.startTime + '-' + value.endTime).join(', ');
}

export function PracticeSettings({ doctor, disabled }: { doctor: boolean; disabled: boolean }) {
  const chamber = useResource('/practice/chamber', chamberResponse);
  const reference = useResource('/practice/reference-schedule', referenceResponse);
  const assistant = useResource(doctor && !disabled ? '/practice/assistant' : null, assistantResponse);
  const [invitation, setInvitation] = useState<Output<typeof setupInvitationSchema>>();
  const chamberTask = useAction();
  const hoursTask = useAction();
  const assistantTask = useAction();

  return <div className="workspace-grid">
    <div className="column">
      <section className="surface">
        <h2>Chamber</h2>
        <Feedback error={chamber.error || chamberTask.error} notice={chamberTask.notice} />
        {chamber.loading && <Empty>Loading chamber…</Empty>}
        {chamber.data !== undefined && <form className="fields" onSubmit={(event) => chamberTask.form(event, async (data) => {
          await write('/practice/chamber', chamberSchema, 'PUT', {
            name: field(data, 'name'), address: field(data, 'address'), contactPhone: field(data, 'contactPhone'),
            defaultConsultationMinutes: Number(field(data, 'minutes'))
          });
          chamber.refresh();
        }, 'Chamber saved.')}>
          <fieldset disabled={disabled || chamberTask.busy}>
            <label>Chamber name<input name="name" defaultValue={chamber.data?.name} required /></label>
            <label>Address<input name="address" defaultValue={chamber.data?.address} required /></label>
            <label>Contact phone<input name="contactPhone" type="tel" defaultValue={chamber.data?.contactPhone} required /></label>
            <label>Default consultation minutes<input name="minutes" type="number" min="1" max="1440" defaultValue={chamber.data?.defaultConsultationMinutes ?? 10} required /></label>
            <button>Save chamber</button>
          </fieldset>
        </form>}
      </section>
      {doctor && !disabled && <section className="surface">
        <h2>Assistant access</h2>
        <Feedback error={assistant.error || assistantTask.error} notice={assistantTask.notice} />
        {assistant.loading && <Empty>Loading assistant…</Empty>}
        {assistant.data && <article className="list-row">
          <div><strong>{assistant.data.name}</strong> <Badge value={assistant.data.status} /><small>{assistant.data.loginId}</small></div>
          <div className="inline">
            {assistant.data.status === 'invited' && <button className="secondary" disabled={assistantTask.busy} onClick={() => void assistantTask.run(async () => {
              setInvitation(await write('/practice/assistant/' + assistant.data!.assignmentId + '/setup', setupInvitationSchema, 'POST', {}));
            })}>Reissue setup</button>}
            <button className="secondary" disabled={assistantTask.busy} onClick={() => {
              if (!window.confirm('Revoke access for this assistant?')) return;
              void assistantTask.run(async () => {
                await emptyWrite('/practice/assistant/' + assistant.data!.assignmentId, 'DELETE');
                setInvitation(undefined);
                assistant.refresh();
              }, 'Assistant access revoked.');
            }}>Revoke</button>
          </div>
        </article>}
        {assistant.data === null && <form className="fields" onSubmit={(event) => assistantTask.form(event, async (data) => {
          const result = await write('/practice/assistant', assistantInvitedSchema, 'POST', {
            name: field(data, 'name'), contactPhone: field(data, 'phone')
          });
          setInvitation(result.invitation);
          assistant.refresh();
        })}>
          <label>Assistant name<input name="name" required /></label>
          <label>Assistant contact phone<input name="phone" type="tel" required /></label>
          <button disabled={assistantTask.busy}>Invite assistant</button>
        </form>}
        {invitation && <SetupInvitation key={invitation.setupToken} invitation={invitation} />}
      </section>}
    </div>
    <section className="surface">
      <h2>Reference hours</h2>
      <p className="quiet">Enter Dhaka times as HH:MM-HH:MM. Separate split hours with commas.</p>
      <Feedback error={reference.error || hoursTask.error} notice={hoursTask.notice} />
      {reference.loading && <Empty>Loading reference hours…</Empty>}
      {reference.data !== undefined && <form className="fields" onSubmit={(event) => hoursTask.form(event, async (data) => {
        const weekly = weekdays.map((_, weekday) => ({ weekday, intervals: parseIntervals(field(data, 'day' + weekday)) }))
          .filter((entry) => entry.intervals.length > 0);
        const overrides = field(data, 'overrides').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
          const [date, ...times] = line.split(/\s+/);
          return { date, intervals: parseIntervals(times.join(' ')) };
        });
        await write('/practice/reference-schedule', referenceScheduleSchema, 'PUT', {
          weekly, overrides, defaultConsultationMinutes: Number(field(data, 'minutes')),
          defaultCapacity: Number(field(data, 'capacity'))
        });
        reference.refresh();
      }, 'Reference hours saved.')}>
        <fieldset disabled={disabled || hoursTask.busy}>
          <div className="field-pair">
            <label>Default minutes<input name="minutes" type="number" min="1" max="1440" defaultValue={reference.data?.defaultConsultationMinutes ?? 10} required /></label>
            <label>Default capacity<input name="capacity" type="number" min="1" max="100000" defaultValue={reference.data?.defaultCapacity ?? 20} required /></label>
          </div>
          {weekdays.map((day, weekday) => <label className="weekday" key={day}>{day}
            <input name={'day' + weekday} placeholder="Closed" defaultValue={intervalsText(reference.data?.weekly.find((entry) => entry.weekday === weekday)?.intervals ?? [])} />
          </label>)}
          <label>Date overrides<textarea name="overrides" rows={3} aria-describedby="override-help"
            defaultValue={reference.data?.overrides.map((entry) => entry.date + ' ' + intervalsText(entry.intervals)).join('\n')} /></label>
          <small id="override-help">One date per line, for example 2026-12-15 09:00-12:00. A date alone closes that day.</small>
          <button>Save reference hours</button>
        </fieldset>
      </form>}
    </section>
  </div>;
}
