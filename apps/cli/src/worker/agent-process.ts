import type { ChildProcess } from 'node:child_process';

import { userMessage } from './messages.js';

export const STOP_KILL_MS = 30_000;

export interface AgentChannel {
  readonly open: boolean;
  send(text: string): boolean;
  closeInput(): void;
  stop(killAfterMs?: number): void;
  killGroup(): void;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      return;
    }
  }
}

export function openChannel(child: ChildProcess): AgentChannel {
  let open = child.stdin !== null;
  let stopping = false;
  child.stdin?.on('error', () => undefined);
  child.stdin?.on('close', () => {
    open = false;
  });
  const closeInput = (): void => {
    if (!open) return;
    open = false;
    child.stdin?.end();
  };
  return {
    get open() {
      return open;
    },
    send(text) {
      if (!open || child.stdin === null) return false;
      child.stdin.write(userMessage(text));
      return true;
    },
    closeInput,
    killGroup() {
      signalGroup(child, 'SIGKILL');
    },
    stop(killAfterMs = STOP_KILL_MS) {
      if (stopping) return;
      stopping = true;
      signalGroup(child, 'SIGINT');
      closeInput();
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) signalGroup(child, 'SIGKILL');
      }, killAfterMs).unref();
    },
  };
}
