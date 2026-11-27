import type { WireSchedule } from '@rumo/contract';
import { bindings, open, type Binding, type Keys } from '@rumo/sealing';

export interface OpenSchedule {
  readonly wire: WireSchedule;
  readonly title: string | null;
  readonly input: string | null;
  readonly agent: string | null;
  readonly icon: string | null;
  readonly labels: readonly string[];
}

async function attempt(keys: Keys, binding: Binding, envelope: string): Promise<string | null> {
  try {
    return await open(keys, binding, envelope);
  } catch {
    return null;
  }
}

function labelsOf(text: string | null): string[] {
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed.filter((label): label is string => typeof label === 'string')
      : [];
  } catch {
    return [];
  }
}

export async function openSchedule(keys: Keys, wire: WireSchedule): Promise<OpenSchedule> {
  const origin = { schedule: wire.id };
  const agent =
    wire.agent === null || wire.agent === undefined
      ? null
      : await attempt(keys, bindings.agent(origin), wire.agent);
  let input: string | null = null;
  for (const creator of ['user', 'agent', 'intake'] as const) {
    input = await attempt(keys, bindings.input({ origin, creator, agent }), wire.input);
    if (input === null && wire.directoryId !== null) {
      input = await attempt(
        keys,
        bindings.input({ origin, creator, agent, directoryId: wire.directoryId }),
        wire.input,
      );
    }
    if (input !== null) break;
  }
  return {
    wire,
    title: await attempt(keys, bindings.title(origin), wire.title),
    input,
    agent,
    icon:
      wire.icon === null || wire.icon === undefined
        ? null
        : await attempt(keys, bindings.icon(origin), wire.icon),
    labels:
      wire.labels === null || wire.labels === undefined
        ? []
        : labelsOf(await attempt(keys, bindings.labels(origin), wire.labels)),
  };
}
