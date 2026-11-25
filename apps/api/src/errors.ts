import { ERROR_STATUS, type ErrorBody, type ErrorCode } from '@agent-board/contract';

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const INTERNAL_MESSAGE = 'internal error';

export const errorStatus = (code: ErrorCode): number => ERROR_STATUS[code];

export const errorPayload = (code: ErrorCode, message: string): ErrorBody => ({
  error: { code, message },
});
