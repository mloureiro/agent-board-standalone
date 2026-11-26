import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { type Session, until } from './support.js';

export interface FakeApi {
  commands: string[];
  close: () => Promise<void>;
}

export interface FakeApiBehaviour {
  holdNever?: boolean;
  holdDelayMs?: number;
  pairCode?: string;
  pairRefusal?: string;
}

export async function fakeControlSocket(
  root: string,
  behaviour: FakeApiBehaviour = {},
): Promise<FakeApi> {
  const commands: string[] = [];
  const socket = join(root, 'run/api.sock');
  mkdirSync(join(root, 'run'), { recursive: true });
  rmSync(socket, { force: true });
  const server: Server = createServer((request, response) => {
    request.resume();
    const command = (request.url ?? '').slice(1);
    commands.push(command);
    const answer = (): void => {
      if (command === 'pair-code' && behaviour.pairRefusal !== undefined) {
        const refusal = JSON.stringify({ error: behaviour.pairRefusal });
        response.writeHead(409, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(refusal),
        });
        response.end(refusal);
        return;
      }
      const body =
        command === 'status'
          ? '{"ok":true,"state":"running"}'
          : command === 'pair-code'
            ? JSON.stringify({ code: behaviour.pairCode })
            : '{"ok":true}';
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
    };
    if (command === 'hold' && behaviour.holdNever) return;
    if (command === 'hold' && behaviour.holdDelayMs !== undefined) {
      setTimeout(answer, behaviour.holdDelayMs);
      return;
    }
    answer();
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return {
    commands,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export interface BackupView {
  inProgress: boolean;
  lastBackup: string | null;
  lastError: string | null;
}

export function lastBackupView(session: Session): BackupView | undefined {
  const states = session.events.filter((event) => event['type'] === 'state');
  return states.at(-1)?.['backup'] as BackupView | undefined;
}

export async function backupNow(session: Session): Promise<Record<string, unknown>> {
  const before = session.events.length;
  session.send('backup-now');
  await until(
    () =>
      session.events
        .slice(before)
        .some((event) => event['type'] === 'action' && event['action'] === 'backup-now'),
    'the backup-now answer',
  );
  return session.events
    .slice(before)
    .find((event) => event['type'] === 'action' && event['action'] === 'backup-now') as Record<
    string,
    unknown
  >;
}

export function backupNames(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}
