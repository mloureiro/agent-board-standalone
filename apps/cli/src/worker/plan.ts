import { randomUUID } from 'node:crypto';

import type { OpenNote, OpenTask } from '../commands/tasks/open.js';
import type { SessionStore } from './sessions.js';

export interface ForkParent {
  readonly id: string;
  readonly sessionId: string | null;
}

export type RunPlan =
  | { readonly kind: 'fresh'; readonly sessionId: string }
  | {
      readonly kind: 'fork';
      readonly sessionId: string;
      readonly fromSessionId: string;
      readonly parent: string;
    }
  | { readonly kind: 'resume'; readonly sessionId: string; readonly prompt: string }
  | { readonly kind: 'blocked'; readonly reason: string };

export const CONTINUE_PROMPT = 'Continue where you left off.';

const UNREADABLE_NOTE =
  "A note in this task's thread could not be decrypted with this machine's data key and this run would have handed it to the agent, so it was not run. Check the data key, or use Re-run fresh.";

export function resumePrompt(notes: readonly OpenNote[]): { text: string; unreadable: boolean } {
  const lastAgent = notes.map((note) => note.author).lastIndexOf('agent');
  const since = notes.slice(lastAgent + 1).filter((note) => note.author !== 'agent');
  const unreadable = since.some((note) => note.unreadable);
  const parts = since.flatMap((note) => {
    const text = note.text ?? note.answers;
    return text === null || text.trim() === '' ? [] : [text.trim()];
  });
  return { text: parts.length === 0 ? CONTINUE_PROMPT : parts.join('\n\n'), unreadable };
}

export function planRun(input: {
  readonly task: OpenTask;
  readonly notes: readonly OpenNote[];
  readonly sessions: SessionStore;
  readonly parent?: ForkParent | undefined;
  readonly newSessionId?: () => string;
}): RunPlan {
  const { task, sessions } = input;
  const make = input.newSessionId ?? randomUUID;
  const wire = task.wire;
  if (wire.next === 'resume' && wire.sessionId !== null) {
    if (!sessions.has(task.id, wire.sessionId)) {
      return {
        kind: 'blocked',
        reason: `The board asks to resume Claude session ${wire.sessionId}, which this machine did not record for this task, so the run was not started. Use Re-run fresh to start over.`,
      };
    }
    const prompt = resumePrompt(input.notes);
    if (prompt.unreadable) return { kind: 'blocked', reason: UNREADABLE_NOTE };
    return { kind: 'resume', sessionId: wire.sessionId.toLowerCase(), prompt: prompt.text };
  }
  if (wire.forkOf !== undefined) {
    const blocked = (why: string): RunPlan => ({
      kind: 'blocked',
      reason: `This task was forked from task ${wire.forkOf}, ${why}, so there is no session to continue and the run was not started. Close it, or fork the task you want to continue again.`,
    });
    const { parent } = input;
    if (parent === undefined) return blocked('which is not on the board any more');
    if (parent.id !== wire.forkOf) return blocked('but the board answered with another task');
    if (parent.sessionId === null) return blocked('which has no Claude session');
    if (!sessions.has(parent.id, parent.sessionId)) {
      return blocked(
        'whose session this machine did not record, and a fork runs where its parent ran',
      );
    }
    return {
      kind: 'fork',
      sessionId: make(),
      fromSessionId: parent.sessionId.toLowerCase(),
      parent: parent.id,
    };
  }
  return { kind: 'fresh', sessionId: make() };
}
