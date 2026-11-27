import type { UiAccountSummary } from '@rumo/contract';
import { and, eq } from 'drizzle-orm';

import {
  appUser,
  directory,
  document,
  machine,
  note,
  project,
  schedule,
  task,
  taskPr,
  transcriptEvent,
  transcriptRun,
} from '../../db/schema/index.js';
import type { ScopedDatabase } from '../database/index.js';

export const accountSummary = async (
  tx: ScopedDatabase,
  owner: string,
): Promise<UiAccountSummary> => {
  const documents = await tx
    .select({ kind: document.kind })
    .from(document)
    .where(eq(document.owner, owner));
  const has = (kind: string): number => documents.filter((row) => row.kind === kind).length;
  const [
    running,
    tasks,
    schedules,
    machines,
    notes,
    taskPrs,
    transcriptRuns,
    transcriptEvents,
    projects,
    directories,
  ] = await Promise.all([
    tx.$count(task, and(eq(task.owner, owner), eq(task.status, 'running'))),
    tx.$count(task, eq(task.owner, owner)),
    tx.$count(schedule, eq(schedule.owner, owner)),
    tx.$count(machine, eq(machine.owner, owner)),
    tx.$count(note, eq(note.owner, owner)),
    tx.$count(taskPr, eq(taskPr.owner, owner)),
    tx.$count(transcriptRun, eq(transcriptRun.owner, owner)),
    tx.$count(transcriptEvent, eq(transcriptEvent.owner, owner)),
    tx.$count(project, eq(project.owner, owner)),
    tx.$count(directory, eq(directory.owner, owner)),
  ]);
  return {
    running,
    tasks,
    schedules,
    machines,
    titleRules: has('titles'),
    notes,
    taskPrs,
    sharedAgents: has('agents'),
    linkRules: has('links'),
    transcriptRuns,
    transcriptEvents,
    projects,
    directories,
  };
};

export const deleteAccount = async (tx: ScopedDatabase, owner: string): Promise<void> => {
  await tx.delete(appUser).where(eq(appUser.username, owner));
};
