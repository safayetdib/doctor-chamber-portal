import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import * as contracts from '@practice/contracts';

type Contract = keyof typeof contracts;
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Access = 'public' | 'account' | 'administrator' | 'doctor' | 'staff' | 'patient';
type Operation = {
  access: Access;
  status?: number;
  body?: Contract;
  optionalBody?: boolean;
  query?: z.ZodObject;
  idempotent?: boolean;
  nullable?: boolean;
  setsCookie?: boolean;
  clearsCookie?: boolean;
};

const components: Record<string, unknown> = {};
const paths: Record<string, Record<string, unknown>> = {};
const afterQuery = z.strictObject({ after: contracts.idSchema.optional() });

function schemaFor(schema: z.ZodType, io: 'input' | 'output') {
  const json = z.toJSONSchema(schema, { io });
  delete json.$schema;
  return json;
}

function reference(name: Contract, io: 'input' | 'output' = 'output') {
  const component = name.replace(/Schema$/, '') + (io === 'input' ? 'Input' : '');
  const schema = contracts[name];
  if (!(schema instanceof z.ZodType)) throw new Error(`Expected a public schema for ${name}.`);
  components[component] ??= schemaFor(schema, io);
  return { $ref: `#/components/schemas/${component}` };
}

const requestId = { 'X-Request-Id': { description: 'Request correlation ID.', schema: { type: 'string', format: 'uuid' } } };
const responseCookie = { 'Set-Cookie': {
  description: 'Sets or clears the HttpOnly, SameSite=Strict JWT session cookie. HTTPS uses the Secure __Host- cookie. JWTs remain subject to server-side session revocation.',
  schema: { type: 'string' }
} };
const json = (schema: object) => ({ 'application/json': { schema } });

function route(method: Method, path: string, summary: string, result: Contract | 'empty' | 'events', options: Operation) {
  const parameters = [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
    name, in: 'path', required: true, schema: reference(name === 'date' ? 'dateSchema' : 'idSchema', 'input')
  }));
  const query = Object.entries<z.ZodType>(options.query?.shape ?? {}).map(([name, schema]) => ({
    name, in: 'query', required: false, schema: schemaFor(schema, 'input')
  }));
  const headers = [];
  if (method !== 'get') headers.push({
    name: 'Origin', in: 'header', required: true, description: 'Must match PUBLIC_APP_ORIGIN.',
    schema: { type: 'string', format: 'uri' }
  });
  if (options.idempotent) headers.push({
    name: 'Idempotency-Key', in: 'header', required: true, description: 'Reuse for retries of the same committed command and payload.',
    schema: reference('idempotencyKeySchema', 'input')
  });
  const responseHeaders = options.setsCookie || options.clearsCookie ? { ...requestId, ...responseCookie } : requestId;
  const success = result === 'empty' ? { description: 'No content.', headers: responseHeaders }
    : result === 'events' ? {
      description: 'Server-sent refresh signals and heartbeats. Fetch a fresh authorized snapshot after a refresh event or reconnect.',
      headers: requestId,
      content: { 'text/event-stream': { schema: { type: 'string' } } }
    } : {
      description: 'Success.', headers: responseHeaders,
      content: json(options.nullable ? { anyOf: [reference(result), { type: 'null' }] } : reference(result))
    };
  const responses: Record<string, unknown> = {
    [options.status ?? (result === 'empty' ? 204 : 200)]: success,
    default: { description: 'API error. Consult error.code for the application error, including booking confirmation and stale queue errors.',
      headers: requestId, content: json(reference('apiErrorSchema')) }
  };
  if (path === '/health/ready') responses[503] = {
    description: 'Replica set unavailable or shutdown in progress.', headers: requestId,
    content: json(reference('healthResponseSchema'))
  };
  const security = options.access === 'public' ? [] : [{ httpsSession: [] }, { localSession: [] }];
  const pathOperations = paths[path] ??= {};
  if (pathOperations[method]) throw new Error(`Duplicate OpenAPI operation ${method} ${path}.`);
  pathOperations[method] = {
    summary, description: `Access: ${options.access}. Server-side ownership, state, and validation rules also apply.`,
    security, parameters: [...parameters, ...query, ...headers],
    ...(options.body && { requestBody: { required: !options.optionalBody, content: json(reference(options.body, 'input')) } }),
    responses
  };
}

const publicAccess = { access: 'public' } as const;
const account = { access: 'account' } as const;
const administrator = { access: 'administrator' } as const;
const doctor = { access: 'doctor' } as const;
const staff = { access: 'staff' } as const;
const patient = { access: 'patient' } as const;

route('get', '/health/live', 'Check process liveness', 'healthResponseSchema', publicAccess);
route('get', '/health/ready', 'Check database readiness', 'healthResponseSchema', publicAccess);
route('post', '/auth/login', 'Sign in with a password', 'accountSchema', { ...publicAccess, body: 'loginSchema', setsCookie: true });
route('get', '/auth/me', 'Get the signed-in account', 'accountSchema', account);
route('patch', '/auth/me', 'Update the signed-in profile', 'accountSchema', { ...account, body: 'profileUpdateSchema' });
route('post', '/auth/logout', 'Sign out and clear the session cookie', 'empty', { ...publicAccess, clearsCookie: true });
route('post', '/auth/setup', 'Activate an invited account', 'accountSchema', { ...publicAccess, body: 'setupSchema', setsCookie: true });
route('post', '/auth/signup/start', 'Request patient signup OTP', 'challengeResponseSchema', { ...publicAccess, body: 'patientDetailsSchema', status: 202 });
route('post', '/auth/signup/complete', 'Verify patient signup OTP and sign in', 'accountSchema', { ...publicAccess, body: 'signupCompleteSchema', status: 201, setsCookie: true });
route('post', '/auth/phone-grant/start', 'Request OTP to enable phone sign-in', 'challengeResponseSchema', { ...account, body: 'phoneGrantSchema', status: 202 });
route('post', '/auth/phone-grant/complete', 'Verify OTP and enable phone sign-in', 'empty', { ...account, body: 'otpSchema' });
route('delete', '/auth/phone-grant', 'Disable phone sign-in', 'empty', account);
route('post', '/auth/phone-login/start', 'Request account-specific sign-in OTP', 'challengeResponseSchema', { ...publicAccess, body: 'otpAccountSchema', status: 202 });
route('post', '/auth/phone-login/complete', 'Sign in with a phone OTP', 'accountSchema', { ...publicAccess, body: 'otpSchema', setsCookie: true });
route('post', '/auth/recovery/start', 'Request OTP using the authorized phone', 'challengeResponseSchema', { ...publicAccess, body: 'otpAccountSchema', status: 202 });
route('post', '/auth/recovery/complete', 'Reset a password with a recovery OTP', 'empty', { ...publicAccess, body: 'signupCompleteSchema' });
route('post', '/admin/account-recovery', 'Issue an operator recovery token', 'operatorRecoveryResponseSchema', { ...administrator, body: 'operatorRecoverySchema', status: 201 });
route('post', '/auth/recovery/operator/complete', 'Reset a password with an operator token', 'empty', { ...publicAccess, body: 'setupSchema' });

route('post', '/admin/practices', 'Provision a practice and invite its doctor', 'doctorCreatedSchema', { ...administrator, body: 'createDoctorSchema', status: 201 });
route('get', '/admin/practices', 'List practices for administration', 'practicePageSchema', { ...administrator, query: afterQuery });
route('get', '/admin/practice-accounts', 'List doctor account activation and practice access', 'adminPracticePageSchema', { ...administrator, query: afterQuery });
route('get', '/admin/practices/{doctorId}', 'Read a practice for administration', 'practiceSchema', administrator);
route('patch', '/admin/practices/{doctorId}/status', 'Change practice access', 'practiceSchema', { ...administrator, body: 'practiceStatusRequestSchema' });
route('post', '/admin/practices/{doctorId}/setup', 'Reissue a doctor setup invitation', 'setupInvitationSchema', { ...administrator, status: 201 });
route('get', '/practice', 'Get the assigned practice', 'practiceSchema', staff);
route('get', '/practice/assistant', 'Get the practice assistant assignment', 'assistantAssignmentSchema', { ...doctor, nullable: true });
route('post', '/practice/assistant', 'Invite an assistant', 'assistantInvitedSchema', { ...doctor, body: 'assistantInviteSchema', status: 201 });
route('post', '/practice/assistant/{assignmentId}/setup', 'Reissue an assistant setup invitation', 'setupInvitationSchema', { ...doctor, status: 201 });
route('delete', '/practice/assistant/{assignmentId}', 'Revoke an assistant assignment', 'empty', doctor);
route('post', '/patients', 'Register and invite a patient', 'patientRegistrationSchema', { ...staff, body: 'patientDetailsSchema', status: 201 });
route('post', '/patients/lookup', 'Look up a patient by exact login ID', 'patientIdentitySchema', { ...staff, body: 'patientLookupSchema' });
route('patch', '/patients/{patientId}', 'Correct preregistration details', 'patientIdentitySchema', { ...staff, body: 'patientDetailsSchema' });
route('post', '/patients/{patientId}/setup', 'Reissue a patient setup invitation', 'setupInvitationSchema', { ...staff, status: 201 });

route('get', '/practice/chamber', 'Read chamber settings', 'chamberSchema', { ...staff, nullable: true });
route('put', '/practice/chamber', 'Save chamber settings', 'chamberSchema', { ...staff, body: 'chamberRequestSchema' });
route('get', '/practice/reference-schedule', 'Read reference hours', 'referenceScheduleSchema', { ...staff, nullable: true });
route('put', '/practice/reference-schedule', 'Save reference hours', 'referenceScheduleSchema', { ...staff, body: 'referenceScheduleRequestSchema' });
route('get', '/practice/reference-schedule/prefill/{date}', 'Get draft defaults for a service date', 'schedulePrefillSchema', staff);
route('get', '/practice/sessions', 'List practice sessions', 'staffSessionPageSchema', { ...staff, query: contracts.sessionListQuerySchema });
route('post', '/practice/sessions', 'Create a draft session', 'staffSessionSchema', { ...staff, body: 'createSessionSchema', status: 201 });
route('patch', '/practice/sessions/{sessionId}', 'Edit a session', 'staffSessionSchema', { ...staff, body: 'editSessionSchema' });
route('post', '/practice/sessions/{sessionId}/publish', 'Publish a draft session', 'staffSessionSchema', { ...staff, body: 'publishSessionSchema' });
route('patch', '/practice/sessions/{sessionId}/booking-open', 'Change public booking availability', 'staffSessionSchema', { ...staff, body: 'setBookingOpenSchema' });
route('get', '/practices', 'List public practices', 'publicPracticePageSchema', { ...publicAccess, query: contracts.publicPracticeQuerySchema });
route('get', '/practices/{doctorId}/sessions', 'List bookable sessions', 'availableSessionPageSchema', { ...publicAccess, query: contracts.sessionListQuerySchema });
route('get', '/bookings', 'List bookings for the signed-in patient', 'bookingPageSchema', { ...patient, query: contracts.bookingListQuerySchema });
route('get', '/practice/sessions/{sessionId}/bookings', 'List staff booking history for a session', 'staffBookingPageSchema', { ...staff, query: contracts.bookingListQuerySchema });
route('post', '/sessions/{sessionId}/bookings', 'Book a session as staff or patient', 'bookingSummarySchema', { ...account, body: 'createBookingSchema', idempotent: true, status: 201 });
route('delete', '/bookings/{bookingId}', 'Cancel an eligible booking as staff or its patient', 'bookingSummarySchema', { ...account, body: 'cancelBookingRequestSchema', optionalBody: true, idempotent: true });

route('get', '/practice/sessions/{sessionId}/queue', 'Read the staff queue snapshot', 'staffQueueSnapshotSchema', staff);
route('get', '/sessions/{sessionId}/queue', 'Read your booking and the anonymous queue', 'patientQueueSnapshotSchema', patient);
route('get', '/practice/sessions/{sessionId}/queue/events', 'Subscribe to staff queue refresh signals', 'events', staff);
route('get', '/sessions/{sessionId}/queue/events', 'Subscribe to patient queue refresh signals', 'events', patient);
route('post', '/practice/sessions/{sessionId}/queue/commands', 'Apply a revision-checked session or queue command', 'queueCommandResultSchema', { ...staff, body: 'queueCommandSchema', idempotent: true });
route('post', '/practice/sessions/{sessionId}/queue/special-bookings', 'Add a special booking', 'bookingSummarySchema', { ...staff, body: 'specialBookingSchema', idempotent: true, status: 201 });

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Chamber queue API', version: '1.0.0',
    description: 'Generated from the operation catalog and public Zod contracts. Input transformations and cross-field rules are enforced by the API. Phone inputs accept international numbers and local Bangladesh mobile format.'
  },
  servers: [{ url: '/api/v1' }],
  paths,
  components: {
    securitySchemes: {
      httpsSession: { type: 'apiKey', in: 'cookie', name: '__Host-practice_session' },
      localSession: { type: 'apiKey', in: 'cookie', name: 'practice_session' }
    },
    schemas: components
  }
};
// Route declarations use literal Express paths. Check coverage separately from schema generation.
const documented = Object.entries(paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => method + ' ' + path));
const implemented = ['../app.ts', '../identity/routes.ts', '../scheduling/routes.ts'].flatMap((source) => {
  const code = readFileSync(new URL(source, import.meta.url), 'utf8');
  return [...code.matchAll(/\b(?:app|router)\.(get|post|put|patch|delete)\('([^']+)'/g)].map(([, method, path]) =>
    method + ' ' + path!.replace(/^\/api\/v1/, '').replace(/:(\w+)/g, '{$1}')
  );
});
if (documented.sort().join('\n') !== implemented.sort().join('\n')) {
  throw new Error('OpenAPI operation catalog does not match the Express routes.');
}

const file = new URL('../../../docs/openapi.json', import.meta.url);
const generated = JSON.stringify(spec, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const existing = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
  if (existing !== generated) throw new Error('OpenAPI is out of date. Run pnpm openapi:generate and commit docs/openapi.json.');
} else {
  writeFileSync(file, generated);
}
