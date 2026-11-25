import { CliError } from '../errors.js';

export class ApiError extends CliError {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(`${message} (${status} ${code})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}
