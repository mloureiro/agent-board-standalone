import type { Context } from '../commands/context.js';
import type { RunFiles } from '../shutdown/index.js';
import type { ProcessOps } from '../shutdown/index.js';
import type { Session } from '../transport/session.js';
import type { DispatchConfig } from './config.js';
import type { RunRecords } from './run-record.js';
import type { StartedWorker } from './spawn.js';

export interface TickEnv {
  readonly ctx: Context;
  readonly s: Session;
  readonly config: DispatchConfig;
  readonly records: RunRecords;
  readonly files: RunFiles;
  readonly processes: ProcessOps;
  readonly now: () => Date;
  readonly log: (line: string) => void;
  readonly start: (task: string) => Promise<StartedWorker>;
}
