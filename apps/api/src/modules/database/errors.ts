export class DatabaseRefusal extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`the database is not usable:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'DatabaseRefusal';
  }
}

export class StatementRefused extends Error {
  constructor() {
    super('the statement is not allowed on a request transaction');
    this.name = 'StatementRefused';
  }
}
