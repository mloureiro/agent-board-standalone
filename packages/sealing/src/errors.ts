export class SealingError extends Error {
  override readonly name: string = 'SealingError';
}

export class KeyError extends Error {
  override readonly name: string = 'KeyError';
}

export class WrongSecretError extends KeyError {
  override readonly name: string = 'WrongSecretError';
}
