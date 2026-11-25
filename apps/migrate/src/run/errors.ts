export class RunRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunRefusal';
  }
}

export class ImportFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportFailure';
  }
}

export class CountCheckFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CountCheckFailure';
  }
}
