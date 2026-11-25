export type EventMessage =
  | { kind: 'change'; projectId?: string }
  | { kind: 'tasks' }
  | { kind: 'revoked'; machineId: string }
  | { kind: 'resync' };

export interface EventBus {
  publish(owner: string, message: Exclude<EventMessage, { kind: 'resync' }>): Promise<void>;
  subscribe(owner: string, listener: (message: EventMessage) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export const publishChange = (
  bus: EventBus,
  owner: string,
  change: { projectId?: string } = {},
): Promise<void> =>
  bus.publish(
    owner,
    change.projectId === undefined
      ? { kind: 'change' }
      : { kind: 'change', projectId: change.projectId },
  );

export const publishTasks = (bus: EventBus, owner: string): Promise<void> =>
  bus.publish(owner, { kind: 'tasks' });

export const publishRevoked = (bus: EventBus, owner: string, machineId: string): Promise<void> =>
  bus.publish(owner, { kind: 'revoked', machineId });
