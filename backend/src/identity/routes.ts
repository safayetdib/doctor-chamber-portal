import { Router, type Request, type Response } from 'express';
import {
  assistantInviteSchema, challengeResponseSchema, createDoctorSchema, idSchema, loginSchema,
  operatorRecoveryResponseSchema, operatorRecoverySchema, otpAccountSchema, otpSchema, patientDetailsSchema, patientLookupSchema, phoneGrantSchema,
  practiceStatusRequestSchema, profileUpdateSchema, setupInvitationSchema, setupSchema, signupCompleteSchema
} from '@practice/contracts';
import { AccessService } from './access.js';
import { AuthService, sessionLifetimeMs } from './auth.js';
import type { RequestContext } from './context.js';
import { IdentityError } from './security.js';
import { parse } from '../http/validation.js';
import type { BookingService } from '../scheduling/bookings.js';
import type { SessionService } from '../scheduling/sessions.js';
import { createSchedulingRouter } from '../scheduling/routes.js';
import type { QueueService } from '../queue/service.js';
import type { QueueEvents } from '../queue/events.js';

export function createApiRouter(
  auth: AuthService, access: AccessService, sessions: SessionService, bookings: BookingService, queue: QueueService,
  origin: string, secure: boolean, queueEvents?: QueueEvents
) {
  const router = Router();
  const cookieName = secure ? '__Host-practice_session' : 'practice_session';
  const cookie = { httpOnly: true, secure, sameSite: 'strict', path: '/' } as const;

  function context(request: Request): RequestContext {
    const token = request.get('Cookie')?.split(';').map((part) => part.trim())
      .find((part) => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    return {
      requestId: String(request.id), ip: request.ip ?? request.socket.remoteAddress ?? 'unknown',
      token: token && token.length <= 2048 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ? token : undefined
    };
  }

  function signedIn(response: Response, result: Awaited<ReturnType<AuthService['login']>>, status = 200) {
    response.cookie(cookieName, result.token, { ...cookie, maxAge: sessionLifetimeMs }).status(status).json(result.account);
  }

  // Apply the same origin policy to sign-in, challenge requests and authenticated writes.
  router.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.get('Origin') !== origin) {
      throw new IdentityError(403, 'ORIGIN_REJECTED', 'The request origin is not allowed.');
    }
    next();
  });

  router.post('/auth/login', async (request, response) => {
    signedIn(response, await auth.login(context(request), parse(loginSchema, request.body)));
  });
  router.get('/auth/me', async (request, response) => {
    response.json(await auth.me(context(request)));
  });
  router.post('/auth/logout', async (request, response) => {
    await auth.logout(context(request));
    response.clearCookie(cookieName, cookie).status(204).end();
  });
  router.patch('/auth/me', async (request, response) => {
    response.json(await auth.updateProfile(context(request), parse(profileUpdateSchema, request.body)));
  });
  router.post('/auth/setup', async (request, response) => {
    signedIn(response, await auth.completeSetup(context(request), parse(setupSchema, request.body)));
  });
  router.post('/auth/signup/start', async (request, response) => {
    response.status(202).json(challengeResponseSchema.parse(await auth.startSignup(context(request), parse(patientDetailsSchema, request.body))));
  });
  router.post('/auth/signup/complete', async (request, response) => {
    signedIn(response, await auth.completeSignup(context(request), parse(signupCompleteSchema, request.body)), 201);
  });
  router.post('/auth/phone-grant/start', async (request, response) => {
    response.status(202).json(challengeResponseSchema.parse(await auth.startPhoneGrant(context(request), parse(phoneGrantSchema, request.body))));
  });
  router.post('/auth/phone-grant/complete', async (request, response) => {
    await auth.completePhoneGrant(context(request), parse(otpSchema, request.body));
    response.status(204).end();
  });
  router.delete('/auth/phone-grant', async (request, response) => {
    await auth.disablePhoneLogin(context(request));
    response.status(204).end();
  });
  router.post('/auth/phone-login/start', async (request, response) => {
    const { loginId } = parse(otpAccountSchema, request.body);
    response.status(202).json(challengeResponseSchema.parse(await auth.startAccountOtp(context(request), loginId, 'phone_login')));
  });
  router.post('/auth/phone-login/complete', async (request, response) => {
    signedIn(response, await auth.completePhoneLogin(context(request), parse(otpSchema, request.body)));
  });
  router.post('/auth/recovery/start', async (request, response) => {
    const { loginId } = parse(otpAccountSchema, request.body);
    response.status(202).json(challengeResponseSchema.parse(await auth.startAccountOtp(context(request), loginId, 'phone_recovery')));
  });
  router.post('/auth/recovery/complete', async (request, response) => {
    await auth.recoverPassword(context(request), parse(signupCompleteSchema, request.body));
    response.status(204).end();
  });
  router.post('/admin/account-recovery', async (request, response) => {
    const result = await auth.issueOperatorRecovery(context(request), parse(operatorRecoverySchema, request.body));
    response.status(201).json(operatorRecoveryResponseSchema.parse(result));
  });
  router.post('/auth/recovery/operator/complete', async (request, response) => {
    await auth.completeOperatorRecovery(context(request), parse(setupSchema, request.body));
    response.status(204).end();
  });

  router.post('/admin/practices', async (request, response) => {
    response.status(201).json(await access.createPractice(context(request), parse(createDoctorSchema, request.body)));
  });
  router.get('/admin/practices', async (request, response) => {
    const after = parse(idSchema.optional(), request.query.after);
    response.json(await access.listPractices(context(request), after));
  });
  router.get('/admin/practice-accounts', async (request, response) => {
    response.json(await access.listPracticeAccounts(context(request), parse(idSchema.optional(), request.query.after)));
  });
  router.get('/admin/practices/:doctorId', async (request, response) => {
    response.json(await access.readPractice(context(request), parse(idSchema, request.params.doctorId)));
  });
  router.patch('/admin/practices/:doctorId/status', async (request, response) => {
    const { status } = parse(practiceStatusRequestSchema, request.body);
    response.json(await access.setPracticeStatus(context(request), parse(idSchema, request.params.doctorId), status));
  });
  router.post('/admin/practices/:doctorId/setup', async (request, response) => {
    const invitation = await access.reissueDoctorSetup(context(request), parse(idSchema, request.params.doctorId));
    response.status(201).json(setupInvitationSchema.parse(invitation));
  });
  router.get('/practice', async (request, response) => {
    response.json(await access.readPractice(context(request)));
  });
  router.post('/practice/assistant', async (request, response) => {
    response.status(201).json(await access.inviteAssistant(context(request), parse(assistantInviteSchema, request.body)));
  });
  router.get('/practice/assistant', async (request, response) => {
    response.json(await access.readAssistant(context(request)));
  });
  router.post('/practice/assistant/:assignmentId/setup', async (request, response) => {
    const invitation = await access.reissueAssistantSetup(context(request), parse(idSchema, request.params.assignmentId));
    response.status(201).json(setupInvitationSchema.parse(invitation));
  });
  router.delete('/practice/assistant/:assignmentId', async (request, response) => {
    await access.revokeAssistant(context(request), parse(idSchema, request.params.assignmentId));
    response.status(204).end();
  });
  router.post('/patients', async (request, response) => {
    response.status(201).json(await access.registerPatient(context(request), parse(patientDetailsSchema, request.body)));
  });
  router.post('/patients/lookup', async (request, response) => {
    const { loginId } = parse(patientLookupSchema, request.body);
    response.json(await access.lookupPatient(context(request), loginId));
  });
  router.patch('/patients/:patientId', async (request, response) => {
    response.json(await access.correctPatient(context(request), parse(idSchema, request.params.patientId), parse(patientDetailsSchema, request.body)));
  });
  router.post('/patients/:patientId/setup', async (request, response) => {
    const invitation = await access.reissuePatientSetup(context(request), parse(idSchema, request.params.patientId));
    response.status(201).json(setupInvitationSchema.parse(invitation));
  });

  router.use(createSchedulingRouter(sessions, bookings, queue, context, queueEvents));
  return router;
}
