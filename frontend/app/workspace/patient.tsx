'use client';

import { useCallback, useRef, useState } from 'react';
import {
  availableSessionPageSchema, bookingPageSchema, bookingSummarySchema, patientQueueSnapshotSchema, publicPracticePageSchema
} from '@practice/contracts';
import { localDay, localTime, write } from './api';
import { useAction, useQueueUpdates, useResource } from './hooks';
import { Badge, Empty, Feedback } from './ui';

export function Patient() {
  const [practice, setPractice] = useState('');
  const [selected, setSelected] = useState('');
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const directory = useResource('/practices', publicPracticePageSchema);
  const practiceId = practice || directory.data?.practices[0]?.doctorId || '';
  const available = useResource(practiceId ? '/practices/' + practiceId + '/sessions' : null, availableSessionPageSchema);
  const history = useResource('/bookings' + (historyCursor ? '?after=' + historyCursor : ''), bookingPageSchema);
  const currentSession = selected || history.data?.bookings[0]?.sessionId || '';
  const queuePath = currentSession ? '/sessions/' + currentSession + '/queue' : null;
  const queue = useResource(queuePath, patientQueueSnapshotSchema);
  const snapshot = queue.data;
  const own = snapshot?.ownBooking;
  const viewable = snapshot && ['scheduled', 'running'].includes(snapshot.sessionStatus)
    && own?.status !== 'cancelled' && own?.status !== 'unserved' && own?.unservedCause === undefined;
  const refreshQueue = queue.refresh;
  const refreshHistory = history.refresh;
  const refreshAvailability = available.refresh;
  const refresh = useCallback(() => {
    refreshAvailability();
    refreshHistory();
    refreshQueue();
  }, [refreshAvailability, refreshHistory, refreshQueue]);
  const connection = useQueueUpdates(viewable ? queuePath : null, refresh);
  const action = useAction();
  const queueHeading = useRef<HTMLHeadingElement>(null);

  function showQueue(sessionId: string) {
    setSelected(sessionId);
    queueHeading.current?.focus({ preventScroll: true });
    queueHeading.current?.scrollIntoView({ block: 'start' });
  }

  return <>
    <div className="section-title"><h1>Your consultations</h1><p>Book a session and follow your turn.</p></div>
    <Feedback error={action.error} notice={action.notice} />
    <div className="workspace-grid">
      <div className="column">
        <section className="surface">
          <h2>Book a session</h2>
          <Feedback error={directory.error || available.error} />
          <div className="fields">
            <label>Practice<select value={practiceId} onChange={(event) => setPractice(event.target.value)}>
              {!directory.data?.practices.length && <option value="">No practices available</option>}
              {directory.data?.practices.map((entry) => <option key={entry.doctorId} value={entry.doctorId}>{entry.displayName}</option>)}
            </select></label>
          </div>
          {(directory.loading || available.loading) && <Empty>Loading sessions…</Empty>}
          {available.data?.sessions.length === 0 && <Empty>This practice has no sessions open for booking.</Empty>}
          {available.data?.sessions.map((entry) => {
            const eligible = ['waiting', 'in_progress', 'missed', 'done'];
            const booked = history.data?.bookings.some((booking) =>
              booking.sessionId === entry.sessionId && eligible.includes(booking.status))
              || (own?.sessionId === entry.sessionId && eligible.includes(own.status));
            return <article className="list-row" key={entry.sessionId}>
            <div><strong>{localDay(entry.startsAt)}</strong><small>
              {localTime(entry.startsAt)} – {localTime(entry.endsAt)} · {entry.remainingCapacity} available
            </small></div>
            {booked ? <button className="secondary" onClick={() => showQueue(entry.sessionId)}>View booking</button>
              : <button disabled={action.busy} onClick={() => void action.run(async () => {
              const booking = await write('/sessions/' + entry.sessionId + '/bookings', bookingSummarySchema, 'POST', {}, true);
              showQueue(booking.sessionId);
              setHistoryCursor(null);
              refresh();
            }, 'Booking confirmed.')}>Book session</button>}
          </article>;
          })}
        </section>
        <section className="surface">
          <div className="inline spread"><h2>Your bookings</h2><button className="secondary" onClick={refresh}>Refresh</button></div>
          <Feedback error={history.error} />
          {history.loading && <Empty>Loading bookings…</Empty>}
          {history.data?.bookings.length === 0 && <Empty>Your bookings will appear here.</Empty>}
          {history.data?.bookings.map((entry) => <article className="list-row" key={entry.bookingId}>
            <div><strong>Serial {entry.serialNumber}</strong> <Badge value={entry.status} /><small>Booked {localDay(entry.createdAt)}</small></div>
            <button className="secondary" aria-pressed={entry.sessionId === currentSession} onClick={() => showQueue(entry.sessionId)}>View queue</button>
          </article>)}
          <div className="inline">
            {historyCursor && <button className="secondary" onClick={() => setHistoryCursor(null)}>Newest bookings</button>}
            {history.data?.nextCursor && <button className="secondary" onClick={() => setHistoryCursor(history.data!.nextCursor)}>Older bookings</button>}
          </div>
        </section>
      </div>
      <section className="surface queue">
        <div className="inline spread">
          <h2 ref={queueHeading} tabIndex={-1} className="queue-heading">Your queue</h2>
          {connection && <span className="connection-state">{connection === 'live' ? 'Live updates' : 'Polling for updates'}</span>}
        </div>
        <Feedback error={queue.error} />
        {queue.loading && <Empty>Loading queue…</Empty>}
        {!currentSession && <Empty>Select a booking to see your serial and wait estimate.</Empty>}
        {own && snapshot && <>
          <div className="serving">
            <div><small>Your serial</small><strong className="serial-number">{own.serialNumber}</strong></div>
            <div><Badge value={own.status} /> {own.special && <Badge value="special" />}
              <p>{own.estimate ? 'Estimated start ' + localTime(own.estimate.estimatedStartAt) + ' Dhaka time' :
                own.status === 'in_progress' ? 'Your consultation is in progress.' :
                  own.unservedCause === 'practice_disabled' ? 'The practice closed this booking.' :
                    own.unservedCause === 'session_ended' ? 'The session ended before your consultation.' : 'Wait estimate unavailable.'}</p>
            </div>
          </div>
          <p className="quiet">Updated {localTime(snapshot.calculatedAt)} Dhaka time</p>
          {viewable && (own.status === 'waiting' || own.status === 'missed') &&
            <button className="secondary" disabled={action.busy} onClick={() => {
              if (!window.confirm('Cancel this booking?')) return;
              void action.run(async () => {
                await write('/bookings/' + own.bookingId, bookingSummarySchema, 'DELETE', {}, true);
                refresh();
              }, 'Booking cancelled.');
            }}>Cancel booking</button>}
          {viewable && <>
            <h3>Now serving</h3>
            {snapshot.current
              ? <p><strong>Serial {snapshot.current.serialNumber}</strong> {snapshot.current.special && <Badge value="special" />}
                {snapshot.current.delayed && <span className="quiet"> · Running longer than estimated</span>}</p>
              : <Empty>A consultation hasn’t started.</Empty>}
            <h3>Waiting order</h3>
            {snapshot.waiting.length ? <ol className="serial-list">{snapshot.waiting.map((entry) =>
              <li key={entry.serialNumber}><span>Serial {entry.serialNumber}</span> {entry.special && <Badge value="special" />}</li>
            )}</ol> : <Empty>No patients are waiting.</Empty>}
            {snapshot.missed.length > 0 && <>
              <h3>Missed</h3>
              <ul className="serial-list missed-list">{snapshot.missed.map((entry) =>
                <li key={entry.serialNumber}>Serial {entry.serialNumber} {entry.special && <Badge value="special" />}</li>)}</ul>
            </>}
          </>}
        </>}
      </section>
    </div>
  </>;
}
