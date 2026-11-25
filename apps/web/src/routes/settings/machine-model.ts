import type { MachineState, RouteResponse, listClientMachinesRoute } from '@agent-board/contract';
import { bindings, type Keys } from '@agent-board/sealing';

import { attempt } from '../board/card-model.js';

type UiMachine = RouteResponse<typeof listClientMachinesRoute>['machines'][number];

export interface MachineView {
  readonly machine: UiMachine;
  readonly usage: readonly string[];
}

export const STATUS_TEXT: Readonly<Record<MachineState, string>> = {
  unknown: 'unknown',
  incompatible: 'incompatible',
  outdated: 'outdated',
  current: 'current',
};

export const usageLines = (text: string | null): readonly string[] => {
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.entries(parsed)
      .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
      .map(([name, value]) => `${name}: ${value.toLocaleString('en-US')}`);
  } catch {
    return [];
  }
};

export async function decryptMachine(keys: Keys, machine: UiMachine): Promise<MachineView> {
  const usage = await attempt(
    keys,
    bindings.machineDocument('machine.usage', machine.name),
    machine.usage,
  );
  return { machine, usage: usageLines(usage) };
}
