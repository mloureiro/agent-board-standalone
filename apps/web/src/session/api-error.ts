import { errorBody } from '@agent-board/contract';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const isUnauthorized = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 401;

export const isKeyUnknown = (error: unknown): boolean =>
  isUnauthorized(error) && (error as ApiError).code === 'key-unknown';

export const readApiError = async (response: Response): Promise<ApiError> => {
  const parsed = errorBody.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? new ApiError(response.status, parsed.data.error.code, parsed.data.error.message)
    : new ApiError(response.status, null, `The server answered ${response.status}.`);
};
