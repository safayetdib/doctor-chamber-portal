import type { Booking, ConsultationSession } from '../scheduling/documents.js';

export function estimateQueue(session: ConsultationSession, current: Booking | null, now: Date) {
  if (current && !current.startedAt) throw new Error('The serving slot has no start timestamp.');
  const nowMs = now.getTime();
  const duration = session.consultationMinutes * 60_000;
  const elapsed = current?.startedAt ? Math.max(0, nowMs - current.startedAt.getTime()) : 0;
  const remaining = current ? Math.max(0, duration - elapsed) : 0;
  const base = session.status === 'running' ? nowMs : Math.max(nowMs, session.startsAt.getTime());
  const firstWaitingStart = base + remaining;
  return {
    delayed: current !== null && elapsed > duration,
    projectedFinish: (waitingCount: number) => new Date(firstWaitingStart + duration * waitingCount),
    waitingEstimate: (ahead: number) => {
      const start = firstWaitingStart + duration * ahead;
      return { estimatedStartAt: new Date(start).toISOString(), waitSeconds: Math.ceil((start - nowMs) / 1000) };
    }
  };
}
