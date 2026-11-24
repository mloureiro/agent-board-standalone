import { z } from 'zod';

export const EVENT_PING_MS = 25_000;
export const MACHINE_EVENT_DEBOUNCE_MS = 500;

export const machineEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('tasks'), data: z.object({}).strict() }).strict(),
]);

export type MachineEvent = z.infer<typeof machineEvent>;
