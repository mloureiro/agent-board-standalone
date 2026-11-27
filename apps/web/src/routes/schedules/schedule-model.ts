import type { Priority, UiScheduleUpdate, WireSchedule } from '@rumo/contract';
import { bindings, seal, type Keys } from '@rumo/sealing';

import { attempt } from '../board/card-model.js';
import { spanText } from '../board/format.js';

export interface ScheduleView {
  readonly wire: WireSchedule;
  readonly title: string;
  readonly prompt: string | null;
  readonly agent: string | null;
}

export const UNREADABLE_SCHEDULE = 'Unreadable schedule';

const inputBinding = (id: string, agent: string | null, directoryId: string | null) =>
  bindings.input({ origin: { schedule: id }, creator: 'user', agent, directoryId });

const openPrompt = async (keys: Keys, wire: WireSchedule, agent: string | null) => {
  const directories = wire.directoryId === null ? [null] : [wire.directoryId, null];
  const agents = agent === null ? [null] : [agent, null];
  for (const directoryId of directories) {
    for (const agentName of agents) {
      const text = await attempt(keys, inputBinding(wire.id, agentName, directoryId), wire.input);
      if (text !== null) return text;
    }
  }
  return null;
};

export async function decryptSchedule(keys: Keys, wire: WireSchedule): Promise<ScheduleView> {
  const [title, agent] = await Promise.all([
    attempt(keys, bindings.title({ schedule: wire.id }), wire.title),
    attempt(keys, bindings.agent({ schedule: wire.id }), wire.agent),
  ]);
  return {
    wire,
    title: title ?? UNREADABLE_SCHEDULE,
    prompt: await openPrompt(keys, wire, agent),
    agent,
  };
}

export function repeatText(wire: WireSchedule): string {
  if (wire.everyMs !== null) return `Every ${spanText(wire.everyMs)}`;
  if (wire.cron !== null) {
    const more = wire.moreCrons?.length ?? 0;
    return `${wire.cron} (${wire.timezone ?? 'UTC'})${more === 0 ? '' : ` and ${more} more`}`;
  }
  return wire.after === null ? 'No repeat' : 'After another schedule';
}

export interface ScheduleEdit {
  readonly title: string;
  readonly prompt: string;
  readonly priority: Priority;
  readonly autoDone: boolean;
  readonly everyMinutes: number | null;
}

const repeatOf = (wire: WireSchedule, everyMinutes: number | null): UiScheduleUpdate['repeat'] => {
  if (wire.everyMs !== null) {
    return { everyMs: everyMinutes === null ? wire.everyMs : everyMinutes * 60_000 };
  }
  if (wire.cron !== null) {
    return {
      cron: wire.cron,
      timezone: wire.timezone ?? 'UTC',
      ...(wire.moreCrons === undefined || wire.moreCrons.length === 0
        ? {}
        : { moreCrons: wire.moreCrons }),
    };
  }
  return { after: wire.after as NonNullable<WireSchedule['after']> };
};

export async function updateRequest(
  keys: Keys,
  view: ScheduleView,
  edit: ScheduleEdit,
): Promise<UiScheduleUpdate> {
  const { wire } = view;
  const [title, input] = await Promise.all([
    seal(keys, bindings.title({ schedule: wire.id }), edit.title),
    seal(keys, inputBinding(wire.id, view.agent, wire.directoryId), edit.prompt),
  ]);
  return {
    id: wire.id,
    title,
    input,
    ...(wire.agent === null || wire.agent === undefined ? {} : { agent: wire.agent }),
    place:
      wire.machine === null || wire.directoryId === null
        ? null
        : { machine: wire.machine, directoryId: wire.directoryId },
    priority: edit.priority,
    model: wire.model,
    effort: wire.effort,
    lane: wire.requestedLane,
    icon: wire.icon ?? null,
    labels: wire.labels ?? null,
    autoDone: edit.autoDone,
    repeat: repeatOf(wire, edit.everyMinutes),
    runsLeft: wire.remaining,
    until: wire.until,
    maxConcurrent: wire.maxConcurrent,
  };
}
