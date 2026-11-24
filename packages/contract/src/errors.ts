import { z } from 'zod';

export const ERROR_STATUS = {
  'bad-request': 400,
  unauthorized: 401,
  'signature-invalid': 401,
  'key-unknown': 401,
  forbidden: 403,
  'grant-required': 403,
  'origin-refused': 403,
  'not-found': 404,
  'not-enabled': 404,
  'method-not-allowed': 405,
  conflict: 409,
  'directory-in-use': 409,
  'run-holds-task': 409,
  'version-conflict': 409,
  'upgrade-required': 412,
  'payload-too-large': 413,
  'unsupported-media-type': 415,
  misdirected: 421,
  unprocessable: 422,
  'too-many-requests': 429,
  internal: 500,
  unavailable: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_CODES = Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]];

export const errorBody = z
  .object({
    error: z.object({ code: z.enum(ERROR_CODES), message: z.string() }).strict(),
  })
  .strict();

export type ErrorBody = z.infer<typeof errorBody>;

const CALLER_ERRORS = [
  'bad-request',
  'unauthorized',
  'signature-invalid',
  'key-unknown',
  'upgrade-required',
  'payload-too-large',
  'unprocessable',
  'misdirected',
  'unavailable',
] as const satisfies readonly ErrorCode[];

export const COMMON_ERRORS: Record<'public' | 'client' | 'machine', readonly ErrorCode[]> = {
  public: ['bad-request', 'payload-too-large', 'unprocessable', 'unavailable'],
  client: CALLER_ERRORS,
  machine: CALLER_ERRORS,
};

export const CLIENT_WRITE_ERRORS = [
  'unsupported-media-type',
  'origin-refused',
] as const satisfies readonly ErrorCode[];
