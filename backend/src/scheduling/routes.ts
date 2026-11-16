import { Router, type Request } from 'express';
import {
  bookingListQuerySchema, cancelBookingRequestSchema, chamberRequestSchema, createBookingSchema, createSessionSchema, dateSchema,
  editSessionSchema, idSchema, idempotencyKeySchema, publicPracticeQuerySchema, publishSessionSchema, referenceScheduleRequestSchema,
  queueCommandSchema, sessionListQuerySchema, setBookingOpenSchema, specialBookingSchema
} from '@practice/contracts';
import type { RequestContext } from '../identity/context.js';
import { parse } from '../http/validation.js';
import type { BookingService } from './bookings.js';
import type { SessionService } from './sessions.js';
import type { QueueService } from '../queue/service.js';

export function createSchedulingRouter(
  sessions: SessionService, bookings: BookingService, queue: QueueService, context: (request: Request) => RequestContext
) {
  const router = Router();

  router.get('/practice/chamber', async (request, response) => {
    response.json(await sessions.readChamber(context(request)));
  });
  router.put('/practice/chamber', async (request, response) => {
    response.json(await sessions.saveChamber(context(request), parse(chamberRequestSchema, request.body)));
  });
  router.get('/practice/reference-schedule', async (request, response) => {
    response.json(await sessions.readReference(context(request)));
  });
  router.put('/practice/reference-schedule', async (request, response) => {
    response.json(await sessions.saveReference(context(request), parse(referenceScheduleRequestSchema, request.body)));
  });
  router.get('/practice/reference-schedule/prefill/:date', async (request, response) => {
    response.json(await sessions.prefill(context(request), parse(dateSchema, request.params.date)));
  });

  router.get('/practice/sessions', async (request, response) => {
    response.json(await sessions.staffSessions(context(request), parse(sessionListQuerySchema, request.query)));
  });
  router.post('/practice/sessions', async (request, response) => {
    response.status(201).json(await sessions.draft(context(request), parse(createSessionSchema, request.body)));
  });
  router.patch('/practice/sessions/:sessionId', async (request, response) => {
    response.json(await sessions.edit(context(request), parse(idSchema, request.params.sessionId), parse(editSessionSchema, request.body)));
  });
  router.post('/practice/sessions/:sessionId/publish', async (request, response) => {
    response.json(await sessions.publish(context(request), parse(idSchema, request.params.sessionId), parse(publishSessionSchema, request.body)));
  });
  router.patch('/practice/sessions/:sessionId/booking-open', async (request, response) => {
    response.json(await sessions.setBookingOpen(
      context(request), parse(idSchema, request.params.sessionId), parse(setBookingOpenSchema, request.body)
    ));
  });
  router.get('/practices', async (request, response) => {
    const { after } = parse(publicPracticeQuerySchema, request.query);
    response.json(await sessions.publicPractices(after));
  });
  router.get('/practices/:doctorId/sessions', async (request, response) => {
    response.json(await sessions.availableSessions(parse(idSchema, request.params.doctorId), parse(sessionListQuerySchema, request.query)));
  });

  router.get('/bookings', async (request, response) => {
    const query = parse(bookingListQuerySchema, request.query);
    response.json(await bookings.patientBookings(context(request), query.after));
  });
  router.get('/practice/sessions/:sessionId/bookings', async (request, response) => {
    const query = parse(bookingListQuerySchema, request.query);
    response.json(await bookings.staffBookings(context(request), parse(idSchema, request.params.sessionId), query.after));
  });
  router.post('/sessions/:sessionId/bookings', async (request, response) => {
    const key = parse(idempotencyKeySchema, request.get('Idempotency-Key'));
    response.status(201).json(await bookings.create(
      context(request), parse(idSchema, request.params.sessionId), parse(createBookingSchema, request.body), key
    ));
  });
  router.delete('/bookings/:bookingId', async (request, response) => {
    const key = parse(idempotencyKeySchema, request.get('Idempotency-Key'));
    const { expectedRevision } = parse(cancelBookingRequestSchema, request.body ?? {});
    response.json(await bookings.cancel(context(request), parse(idSchema, request.params.bookingId), key, expectedRevision));
  });

  router.get('/practice/sessions/:sessionId/queue', async (request, response) => {
    response.json(await queue.staffSnapshot(context(request), parse(idSchema, request.params.sessionId)));
  });
  router.get('/sessions/:sessionId/queue', async (request, response) => {
    response.json(await queue.patientSnapshot(context(request), parse(idSchema, request.params.sessionId)));
  });
  router.post('/practice/sessions/:sessionId/queue/commands', async (request, response) => {
    response.json(await queue.execute(
      context(request), parse(idSchema, request.params.sessionId), parse(queueCommandSchema, request.body),
      parse(idempotencyKeySchema, request.get('Idempotency-Key'))
    ));
  });
  router.post('/practice/sessions/:sessionId/queue/special-bookings', async (request, response) => {
    response.status(201).json(await bookings.createSpecial(
      context(request), parse(idSchema, request.params.sessionId), parse(specialBookingSchema, request.body),
      parse(idempotencyKeySchema, request.get('Idempotency-Key'))
    ));
  });

  return router;
}
