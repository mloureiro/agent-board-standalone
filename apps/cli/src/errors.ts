export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  expectMismatch: 3,
  lockHeld: 75,
  timedOut: 124,
} as const;

export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = EXIT.failure) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT.usage);
    this.name = 'UsageError';
  }
}

export class ReportedFailure extends CliError {
  constructor(exitCode: number, message = '') {
    super(message, exitCode);
    this.name = 'ReportedFailure';
  }
}
