import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { sessionId, taskId } from '@agent-board/contract';

export interface SessionStore {
  has(task: string, session: string): boolean;
  record(task: string, session: string): void;
}

export const sessionsDirectory = (stateDir: string): string => path.join(stateDir, 'sessions');

export function createSessionStore(stateDir: string): SessionStore {
  const directory = sessionsDirectory(stateDir);
  const file = (task: string): string => {
    taskId.parse(task);
    return path.join(directory, task);
  };
  return {
    has(task, session) {
      if (!sessionId.safeParse(session).success) return false;
      try {
        return readFileSync(file(task), 'utf8').trim().toLowerCase() === session.toLowerCase();
      } catch {
        return false;
      }
    },
    record(task, session) {
      sessionId.parse(session);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(file(task), `${session.toLowerCase()}\n`, { mode: 0o600 });
    },
  };
}
