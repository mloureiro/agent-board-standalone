import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export type WatchSource =
  | {
      readonly kind: 'ci';
      readonly pr: string;
      readonly required: boolean;
      readonly ignore?: readonly string[];
      readonly head: string;
      readonly headSince: string;
      readonly cwd: string;
      readonly settingsDir?: string;
    }
  | {
      readonly kind: 'pr-review';
      readonly pr: string;
      readonly self?: string;
      readonly cwd: string;
      readonly settingsDir?: string;
    }
  | {
      readonly kind: 'pr-merged';
      readonly pr: string;
      readonly cwd: string;
      readonly settingsDir?: string;
    }
  | {
      readonly kind: 'command';
      readonly command: string;
      readonly cwd: string;
      readonly settingsDir?: string;
    }
  | {
      readonly kind: 'stream';
      readonly command: string;
      readonly cwd: string;
      readonly starts: number;
      readonly events: number;
      readonly settingsDir?: string;
    }
  | { readonly kind: 'timer' };

export interface WatchDef {
  readonly id: string;
  readonly name: string;
  readonly task: string;
  readonly createdAt: string;
  readonly deadline: string;
  readonly everyMs: number;
  readonly source: WatchSource;
  readonly last?: { readonly at: string; readonly summary: string };
}

export interface WatchEvent {
  readonly id: string;
  readonly task: string;
  readonly name: string;
  readonly at: string;
  readonly kind: 'event' | 'timeout' | 'stopped' | 'exit';
  readonly text: string;
}

export interface Claim {
  readonly def: WatchDef;
  done(): void;
}

export interface Listing {
  readonly defs: WatchDef[];
  readonly unreadable: string[];
}

export function newWatchId(): string {
  return randomBytes(8).toString('hex');
}

function isDef(value: unknown): value is WatchDef {
  if (value === null || typeof value !== 'object') return false;
  const def = value as Record<string, unknown>;
  const source = def.source as Record<string, unknown> | null | undefined;
  return (
    typeof def.id === 'string' &&
    typeof def.name === 'string' &&
    typeof def.task === 'string' &&
    typeof def.deadline === 'string' &&
    typeof def.everyMs === 'number' &&
    typeof source === 'object' &&
    source !== null &&
    typeof source.kind === 'string'
  );
}

export class WatchStore {
  readonly watchesDir: string;
  readonly eventsDir: string;

  constructor(stateDir: string) {
    this.watchesDir = path.join(stateDir, 'watches');
    this.eventsDir = path.join(stateDir, 'watch-events');
  }

  private fileOf(task: string, name: string): string {
    return path.join(this.watchesDir, task, `${name}.json`);
  }

  write(def: WatchDef): void {
    const file = this.fileOf(def.task, def.name);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const staging = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    writeFileSync(staging, `${JSON.stringify(def)}\n`, { mode: 0o600 });
    renameSync(staging, file);
  }

  read(task: string, name: string): WatchDef | undefined {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.fileOf(task, name), 'utf8'));
      return isDef(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  list(task: string): Listing {
    const directory = path.join(this.watchesDir, task);
    if (!existsSync(directory)) return { defs: [], unreadable: [] };
    const defs: WatchDef[] = [];
    const unreadable: string[] = [];
    for (const entry of readdirSync(directory).sort()) {
      if (!entry.endsWith('.json')) continue;
      const def = this.read(task, entry.slice(0, -'.json'.length));
      if (def === undefined) unreadable.push(entry);
      else defs.push(def);
    }
    return { defs, unreadable };
  }

  claim(task: string, name: string, id?: string): Claim | undefined {
    const file = this.fileOf(task, name);
    const mine = `${file}.claimed-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      renameSync(file, mine);
    } catch {
      return undefined;
    }
    let def: WatchDef | undefined;
    try {
      const parsed: unknown = JSON.parse(readFileSync(mine, 'utf8'));
      if (isDef(parsed)) def = parsed;
    } catch {
      def = undefined;
    }
    if (def === undefined || (id !== undefined && def.id !== id)) {
      if (def === undefined) rmSync(mine, { force: true });
      else if (!existsSync(file)) renameSync(mine, file);
      else rmSync(mine, { force: true });
      return undefined;
    }
    return {
      def,
      done: () => {
        rmSync(mine, { force: true });
      },
    };
  }

  tasks(): string[] {
    if (!existsSync(this.watchesDir) && !existsSync(this.eventsDir)) return [];
    const names = new Set<string>();
    for (const root of [this.watchesDir, this.eventsDir]) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root)) names.add(entry);
    }
    return [...names].sort();
  }

  removeEvents(task: string, ids?: readonly string[]): void {
    const directory = path.join(this.eventsDir, task);
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory)) {
      const id = entry.replace(/\.json$/, '');
      if (ids === undefined || ids.includes(id))
        rmSync(path.join(directory, entry), { force: true });
    }
  }

  dropTask(task: string): number {
    let dropped = 0;
    for (const def of this.list(task).defs) {
      const claim = this.claim(task, def.name, def.id);
      if (claim !== undefined) {
        claim.done();
        dropped += 1;
      }
    }
    return dropped;
  }

  writeEvent(event: WatchEvent): void {
    const directory = path.join(this.eventsDir, event.task);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${event.id}.json`);
    const staging = `${file}.tmp-${process.pid}`;
    writeFileSync(staging, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    renameSync(staging, file);
  }

  deleteEvent(event: Pick<WatchEvent, 'id' | 'task'>): void {
    rmSync(path.join(this.eventsDir, event.task, `${event.id}.json`), { force: true });
  }

  events(task: string): WatchEvent[] {
    const directory = path.join(this.eventsDir, task);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((entry) => entry.endsWith('.json'))
      .sort()
      .flatMap((entry) => {
        try {
          return [JSON.parse(readFileSync(path.join(directory, entry), 'utf8')) as WatchEvent];
        } catch {
          return [];
        }
      });
  }
}
