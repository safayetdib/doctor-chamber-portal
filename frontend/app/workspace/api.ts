import { apiErrorSchema } from '@practice/contracts';

export type Schema<T> = { parse(value: unknown): T };
export type Output<S extends Schema<unknown>> = ReturnType<S['parse']>;

export class ApiError extends Error {
  readonly code: string;
  readonly details: Output<typeof apiErrorSchema>['error']['details'];

  constructor(public readonly status: number, result: Output<typeof apiErrorSchema>['error']) {
    super(result.message);
    this.code = result.code;
    this.details = result.details;
  }
}

type Options = { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; signal?: AbortSignal; key?: string };

async function send(path: string, options: Options) {
  const headers = new Headers();
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.key) headers.set('Idempotency-Key', options.key);
  const result = await fetch('/api/v1' + path, {
    method: options.method ?? 'GET', headers, cache: 'no-store',
    ...(options.signal && { signal: options.signal }),
    ...(options.body !== undefined && { body: JSON.stringify(options.body) })
  });
  if (!result.ok) {
    const body = apiErrorSchema.safeParse(await result.json().catch(() => undefined));
    throw new ApiError(result.status, body.success ? body.data.error : {
      code: 'SERVICE_UNAVAILABLE', message: 'The service could not complete this request.', requestId: ''
    });
  }
  return result;
}

export async function request<T>(path: string, schema: Schema<T>, options: Options = {}) {
  return schema.parse(await (await send(path, options)).json());
}

export async function write<T>(
  path: string, schema: Schema<T>, method: NonNullable<Options['method']>, body: unknown, idempotent = false
) {
  const options: Options = { method, body, ...(idempotent && { key: crypto.randomUUID() }) };
  try {
    return await request(path, schema, options);
  } catch (error) {
    if (!idempotent || !(error instanceof TypeError)) throw error;
    return request(path, schema, options);
  }
}

export async function emptyWrite(path: string, method: NonNullable<Options['method']>, body?: unknown) {
  await send(path, { method, body });
}

export function errorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return 'Could not reach the service. Check the connection and try again.';
  return error instanceof Error ? error.message : 'The request could not be completed.';
}

export const field = (data: FormData, key: string) => String(data.get(key) ?? '').trim();

export const localTime = (value: string) => new Intl.DateTimeFormat('en-BD', {
  timeZone: 'Asia/Dhaka', hour: 'numeric', minute: '2-digit'
}).format(new Date(value));

export const localDay = (value: string) => new Intl.DateTimeFormat('en-BD', {
  timeZone: 'Asia/Dhaka', dateStyle: 'medium'
}).format(new Date(value));

export const todayInDhaka = (value = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(value);

export function statusLabel(value: string) {
  const labels: Record<string, string> = {
    scheduled: 'Published', running: 'In session', in_progress: 'In consultation', done: 'Completed',
    pending_setup: 'Pending setup', unserved: 'Unserved'
  };
  return labels[value] ?? value.charAt(0).toUpperCase() + value.slice(1);
}
