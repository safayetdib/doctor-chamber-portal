'use client';

import { useState } from 'react';
import {
  bookingSummarySchema, practiceSchema, queueCommandResultSchema, queueCommandSchema, schedulePrefillSchema,
  staffBookingPageSchema, staffQueueSnapshotSchema, staffSessionPageSchema, staffSessionSchema
} from '@practice/contracts';
import { field, localDay, localTime, statusLabel, todayInDhaka, write, type Output } from './api';
import { useAction, useQueueUpdates, useResource } from './hooks';
import { Badge, Empty, Feedback } from './ui';
import { PracticeSettings } from './settings';
import { BookingDesk } from './booking-desk';

type Session = Output<typeof staffSessionSchema>;
type Command = Output<typeof queueCommandSchema>;
type WithoutRevision<T> = T extends Command ? Omit<T, 'expectedRevision'> : never;
const inputTime = (value: string) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
}).format(new Date(value));

function SessionForm({ defaults, onSaved }: { defaults?: Session; onSaved: (session: Session) => void }) {
  const action = useAction();
  const [date, setDate] = useState(defaults?.serviceDate ?? todayInDhaka());
  const [startTime, setStartTime] = useState(defaults ? inputTime(defaults.startsAt) : '');
  const [endTime, setEndTime] = useState(defaults ? inputTime(defaults.endsAt) : '');
  const [minutes, setMinutes] = useState(defaults?.consultationMinutes ?? 10);
  const [capacity, setCapacity] = useState(defaults?.capacity ?? 20);
  const prefill = useResource(!defaults && date ? '/practice/reference-schedule/prefill/' + date : null, schedulePrefillSchema);

  return <details className="surface">
    <summary>{defaults ? 'Edit session settings' : 'Create a session'}</summary>
    <form className="fields" onSubmit={(event) => action.form(event, async (data, form) => {
      const body = {
        serviceDate: date, startTime, endTime, endDate: field(data, 'endDate') || undefined,
        capacity, consultationMinutes: minutes, ...(defaults && { expectedRevision: defaults.queueRevision })
      };
      const saved = await write('/practice/sessions' + (defaults ? '/' + defaults.sessionId : ''), staffSessionSchema,
        defaults ? 'PATCH' : 'POST', body);
      if (!defaults) form.reset();
      onSaved(saved);
      const disclosure = form.closest('details');
      if (disclosure) disclosure.open = false;
    }, defaults ? 'Session updated.' : 'Draft created.')}>
      <label>Service date<input name="serviceDate" type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label>
      {prefill.data && <label>Reference hours<select defaultValue="" onChange={(event) => {
        const item = prefill.data?.intervals[Number(event.target.value)];
        if (event.target.value === '' || !item) return;
        setStartTime(item.startTime);
        setEndTime(item.endTime);
        if (prefill.data?.consultationMinutes) setMinutes(prefill.data.consultationMinutes);
        if (prefill.data?.capacity) setCapacity(prefill.data.capacity);
      }}>
        <option value="">{prefill.data.intervals.length ? 'Choose hours to prefill' : 'No reference hours for this date'}</option>
        {prefill.data.intervals.map((entry, index) => <option key={entry.startTime} value={index}>{entry.startTime} – {entry.endTime}</option>)}
      </select></label>}
      <div className="field-pair">
        <label>Start time<input placeholder="HH:MM" name="startTime" value={startTime} onChange={(event) => setStartTime(event.target.value)}
          pattern="[0-9]{2}:[0-9]{2}" required /></label>
        <label>End time<input placeholder="HH:MM" name="endTime" value={endTime} onChange={(event) => setEndTime(event.target.value)}
          pattern="[0-9]{2}:[0-9]{2}" required /></label>
      </div>
      <label>End date <span className="optional">if overnight</span><input name="endDate" type="date"
        defaultValue={defaults && todayInDhaka(new Date(defaults.endsAt)) !== date ? todayInDhaka(new Date(defaults.endsAt)) : ''} /></label>
      <div className="field-pair">
        <label>Consultation minutes<input name="minutes" type="number" min="1" max="1440"
          value={minutes} onChange={(event) => setMinutes(event.target.valueAsNumber || 0)} required /></label>
        <label>Capacity<input name="capacity" type="number" min="1" max="100000"
          value={capacity} onChange={(event) => setCapacity(event.target.valueAsNumber || 0)} required /></label>
      </div>
      <button disabled={action.busy}>{defaults ? 'Save session' : 'Create draft'}</button>
    </form>
    <Feedback error={action.error || prefill.error} notice={action.notice} />
  </details>;
}

function StaffQueue({ sessionId, disabled, onUpdated }: { sessionId: string; disabled: boolean; onUpdated: () => void }) {
  const path = '/practice/sessions/' + sessionId;
  const resource = useResource(path + '/queue', staffQueueSnapshotSchema);
  const snapshot = resource.data;
  const session = snapshot?.session;
  const active = session?.status === 'scheduled' || session?.status === 'running';
  const connection = useQueueUpdates(active && !disabled ? path + '/queue' : null, resource.refresh);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const history = useResource(historyOpen ? path + '/bookings' + (historyCursor ? '?after=' + historyCursor : '') : null, staffBookingPageSchema);
  const action = useAction();

  function refresh() {
    resource.refresh();
    onUpdated();
    if (historyOpen) history.refresh();
  }

  function command(payload: WithoutRevision<Command>) {
    if (!session) return;
    void action.run(async () => {
      try {
        await write(path + '/queue/commands', queueCommandResultSchema, 'POST', {
          ...payload, expectedRevision: session.queueRevision
        }, true);
      } finally { refresh(); }
    });
  }

  function cancel(bookingId: string) {
    if (!session || !window.confirm('Cancel this booking?')) return;
    void action.run(async () => {
      try {
        await write('/bookings/' + bookingId, bookingSummarySchema, 'DELETE', { expectedRevision: session.queueRevision }, true);
      } finally { refresh(); }
    }, 'Booking cancelled.');
  }

  function publish(open = true) {
    if (!session) return;
    const draft = session.status === 'draft';
    void action.run(async () => {
      try {
        await write(path + (draft ? '/publish' : '/booking-open'), staffSessionSchema, draft ? 'POST' : 'PATCH', {
          expectedRevision: session.queueRevision, bookingOpen: open
        });
      } finally { refresh(); }
    }, draft ? 'Session published.' : open ? 'Public booking opened.' : 'Public booking closed.');
  }

  if (!session || !snapshot) return <section className="surface">
    <Feedback error={resource.error} />
    {resource.loading && <Empty>Loading queue…</Empty>}
    {resource.error && <button className="secondary" onClick={refresh}>Retry</button>}
  </section>;

  const readOnly = disabled || action.busy || !!resource.error;
  return <div className="workspace-grid queue-grid">
    <div className="column">
      <section className="surface">
        <div className="inline spread"><h2>Session</h2><Badge value={session.status} /></div>
        <p>{localDay(session.startsAt)} · {localTime(session.startsAt)} – {localTime(session.endsAt)} Dhaka time</p>
        <p className="quiet">{session.capacityUsed} booked · capacity {session.capacity} · {session.consultationMinutes} min per consultation</p>
        {disabled && <Empty>This practice is disabled. Session history is read-only.</Empty>}
        <Feedback error={resource.error || action.error} notice={action.notice} />
        {resource.error && <button className="secondary" onClick={refresh}>Retry queue</button>}
        {!disabled && session.status === 'draft' && <button disabled={readOnly} onClick={() => publish()}>Publish session</button>}
        {!disabled && active && <>
          <div className="inline">
            <button className="secondary" disabled={readOnly || (!session.bookingOpen && new Date(snapshot.calculatedAt) >= new Date(session.endsAt))}
              onClick={() => publish(!session.bookingOpen)}>{session.bookingOpen ? 'Close public booking' : 'Open public booking'}</button>
          </div>
          <form className="inline duration-form" onSubmit={(event) => {
            event.preventDefault();
            command({ action: 'set-duration', consultationMinutes: Number(new FormData(event.currentTarget).get('minutes')) });
          }}>
            <label>Consultation minutes<input key={session.consultationMinutes} name="minutes" type="number" min="1" max="1440" defaultValue={session.consultationMinutes} required /></label>
            <button className="secondary" disabled={readOnly}>Update duration</button>
          </form>
        </>}
      </section>
      {!disabled && (session.status === 'draft' || session.status === 'scheduled') &&
        <SessionForm key={session.sessionId + ':' + session.startsAt + ':' + session.endsAt} defaults={session} onSaved={refresh} />}
      {!disabled && active && <BookingDesk sessionId={sessionId} revision={session.queueRevision} disabled={readOnly} refresh={refresh} />}
    </div>
    <section className={'surface queue' + (active ? ' current-queue' : '')}>
      <div className="inline spread">
        <h2>Queue</h2>
        {connection && <span className="connection-state">{connection === 'live' ? 'Live updates' : 'Polling for updates'}</span>}
        <button className="secondary" onClick={refresh}>Refresh</button>
      </div>
      <p className="quiet">Updated {localTime(snapshot.calculatedAt)} Dhaka time</p>
      <div className="serving">
        {snapshot.current ? <>
          <div><small>Now serving</small><strong className="serial-number">{snapshot.current.serialNumber}</strong></div>
          <div><strong>{snapshot.current.patientSnapshot.name}</strong>
            <p>{snapshot.current.delayed ? 'Running longer than estimated' : 'Consultation in progress'}</p>
            {!disabled && <div className="inline">
              <button disabled={readOnly} onClick={() => command({ action: 'finish', bookingId: snapshot.current!.bookingId })}>Finish consultation</button>
              <button className="secondary" disabled={readOnly} onClick={() => command({ action: 'miss', bookingId: snapshot.current!.bookingId })}>Mark missed</button>
            </div>}
          </div>
        </> : <><div><small>Now serving</small><p>No current consultation</p></div>
          {!disabled && session.status === 'scheduled' && <button disabled={readOnly}
            onClick={() => command({ action: 'start' })}>Start session</button>}
          {!disabled && session.status === 'running' && <button disabled={readOnly || !snapshot.waiting.length}
            onClick={() => command({ action: 'call-next' })}>Call next</button>}</>}
      </div>
      {!disabled && session.status === 'running' && <div className="inline">
        <button className="secondary" disabled={readOnly || !!snapshot.current} onClick={() => {
          if (window.confirm('End the session? Remaining bookings will be marked unserved.')) command({ action: 'end' });
        }}>End session</button>
        {snapshot.current && <small>Finish or mark the current consultation missed before ending the session.</small>}
      </div>}
      <h3>Waiting order ({snapshot.waiting.length})</h3>
      {snapshot.waiting.length === 0 && <Empty>No patients are waiting.</Empty>}
      {snapshot.waiting.map((entry, index) => <article className="list-row queue-row" key={entry.bookingId}>
        <div><strong>#{entry.serialNumber} · {entry.patientSnapshot.name}</strong> {entry.queueClass !== 'regular' && <Badge value={entry.queueClass} />}
          <small>{entry.patientSnapshot.contactPhone} · Est. {localTime(entry.estimate.estimatedStartAt)}</small>
          {entry.priorityReason && <small>{entry.priorityReason}</small>}
        </div>
        {!disabled && active && <div className="inline queue-actions">
          <button className="secondary compact" disabled={readOnly || index === 0} aria-label={'Move serial ' + entry.serialNumber + ' up'} onClick={() =>
            command({ action: 'move', bookingId: entry.bookingId, beforeBookingId: snapshot.waiting[index - 1]?.bookingId ?? null })}>Up</button>
          <button className="secondary compact" disabled={readOnly || index === snapshot.waiting.length - 1} aria-label={'Move serial ' + entry.serialNumber + ' down'} onClick={() =>
            command({ action: 'move', bookingId: entry.bookingId, beforeBookingId: snapshot.waiting[index + 2]?.bookingId ?? null })}>Down</button>
          <button className="secondary compact" disabled={readOnly} onClick={() => command({ action: 'miss', bookingId: entry.bookingId })}>Mark missed</button>
          <button className="secondary compact" disabled={readOnly} aria-label={'Cancel serial ' + entry.serialNumber} onClick={() => cancel(entry.bookingId)}>Cancel</button>
        </div>}
      </article>)}
      <h3>Missed ({snapshot.missed.length})</h3>
      {snapshot.missed.length === 0 && <Empty>No missed bookings.</Empty>}
      {snapshot.missed.map((entry) => <article className="list-row muted-row" key={entry.bookingId}>
        <div><strong>#{entry.serialNumber} · {entry.patientSnapshot.name}</strong> <Badge value="missed" /></div>
        {!disabled && active && <div className="inline">
          <button className="secondary compact" disabled={readOnly} onClick={() => command({ action: 'restore', bookingId: entry.bookingId })}>Restore</button>
          <button className="secondary compact" disabled={readOnly} aria-label={'Cancel serial ' + entry.serialNumber} onClick={() => cancel(entry.bookingId)}>Cancel</button>
        </div>}
      </article>)}
      <details className="subsection" onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
        <summary>Booking history</summary>
        <Feedback error={history.error} />
        {history.loading && <Empty>Loading booking history…</Empty>}
        {history.data?.bookings.length === 0 && <Empty>No bookings on this page.</Empty>}
        {history.data?.bookings.map((entry) => <article className="list-row" key={entry.bookingId}>
          <strong>#{entry.serialNumber} · {entry.patientSnapshot.name}</strong><Badge value={entry.status} />
        </article>)}
        <div className="inline">
          {historyCursor && <button className="secondary" onClick={() => setHistoryCursor(null)}>Newest bookings</button>}
          {history.data?.nextCursor && <button className="secondary" onClick={() => setHistoryCursor(history.data!.nextCursor)}>Older bookings</button>}
          {history.error && <button className="secondary" onClick={history.refresh}>Retry history</button>}
        </div>
      </details>
    </section>
  </div>;
}

export function Staff({ doctor }: { doctor: boolean }) {
  const [view, setView] = useState<'sessions' | 'practice'>('sessions');
  const [selected, setSelected] = useState('');
  const [filterDate, setFilterDate] = useState('');
  const [sessionCursor, setSessionCursor] = useState<string | null>(null);
  const practice = useResource('/practice', practiceSchema);
  const sessionQuery = new URLSearchParams();
  if (filterDate) sessionQuery.set('date', filterDate);
  if (sessionCursor) sessionQuery.set('after', sessionCursor);
  const sessions = useResource(view === 'sessions' ? '/practice/sessions?' + sessionQuery : null, staffSessionPageSchema);
  const sessionId = sessions.data?.sessions.some((entry) => entry.sessionId === selected)
    ? selected : sessions.data?.sessions[0]?.sessionId ?? '';
  const disabled = practice.data?.status !== 'active';

  return <>
    <div className="section-title">
      <h1>{practice.data?.displayName ?? 'Practice workspace'}</h1>
      <nav className="view-nav" aria-label="Practice workspace">
        <button className="secondary" aria-pressed={view === 'sessions'} onClick={() => { setView('sessions'); practice.refresh(); }}>Sessions</button>
        <button className="secondary" aria-pressed={view === 'practice'} onClick={() => { setView('practice'); practice.refresh(); }}>Practice settings</button>
      </nav>
    </div>
    <Feedback error={practice.error} />
    {view === 'practice' && <PracticeSettings doctor={doctor} disabled={disabled} />}
    {view === 'sessions' && <>
      <div className="session-tools">
        <section className="surface filters">
          <label>Filter by date<input type="date" value={filterDate} onChange={(event) => { setFilterDate(event.target.value); setSessionCursor(null); }} /></label>
          <label>Session<select value={sessionId} onChange={(event) => setSelected(event.target.value)}>
            {!sessionId && <option value="">No sessions found</option>}
            {sessions.data?.sessions.map((entry) => <option value={entry.sessionId} key={entry.sessionId}>
              {localDay(entry.startsAt)} · {localTime(entry.startsAt)} · {statusLabel(entry.status)}
            </option>)}
          </select></label>
          <div className="inline filter-actions">
            {filterDate && <button className="secondary" onClick={() => { setFilterDate(''); setSessionCursor(null); }}>All dates</button>}
            {sessionCursor && <button className="secondary" onClick={() => setSessionCursor(null)}>First sessions</button>}
            {sessions.data?.nextCursor && <button className="secondary" onClick={() => setSessionCursor(sessions.data!.nextCursor)}>More sessions</button>}
          </div>
        </section>
        {!disabled && <SessionForm onSaved={(entry) => {
          if (filterDate && filterDate !== entry.serviceDate) setFilterDate(entry.serviceDate);
          setSessionCursor(null);
          setSelected(entry.sessionId);
          sessions.refresh();
        }} />}
      </div>
      <Feedback error={sessions.error} />
      {sessions.error && <button className="secondary" onClick={sessions.refresh}>Retry sessions</button>}
      {sessions.loading && <Empty>Loading sessions…</Empty>}
      {!sessions.loading && !sessionId && <Empty>{filterDate
        ? 'No sessions on this date. Choose another date or show all dates.'
        : 'Draft a session to set its date, capacity, and consultation length.'}</Empty>}
      {sessionId && <StaffQueue key={sessionId} sessionId={sessionId} disabled={disabled} onUpdated={sessions.refresh} />}
    </>}
  </>;
}
