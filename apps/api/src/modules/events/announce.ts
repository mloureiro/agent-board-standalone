import { publishChange, publishRevoked, publishTasks, type EventBus } from './bus.js';

// A write is already committed when it is announced: a failed publish must not turn it into an error answer.
const quietly = async (publish: Promise<void>): Promise<void> => {
  try {
    await publish;
  } catch {
    return;
  }
};

export const announceChange = (events: EventBus, owner: string, projectId?: string) =>
  quietly(publishChange(events, owner, projectId === undefined ? {} : { projectId }));

export const announceTaskChange = async (
  events: EventBus,
  owner: string,
  projectId?: string,
): Promise<void> => {
  await quietly(publishTasks(events, owner));
  await announceChange(events, owner, projectId);
};

export const announceRevoked = (events: EventBus, owner: string, machineId: string) =>
  quietly(publishRevoked(events, owner, machineId));
