import { listClientProjectsRoute } from '@rumo/contract';
import { bindings, open, type Keys } from '@rumo/sealing';

import { callRoute } from '../auth/api.js';
import type { ServerClient } from '../transport/client.js';

export const DEFAULT_PROJECT_LABEL = 'Default';
export const UNREADABLE_PROJECT_LABEL = 'Unreadable project';

export interface ProjectEntry {
  readonly id: string;
  readonly name: string | null;
  readonly label: string;
  readonly icon: string | null;
  readonly isDefault: boolean;
  readonly archived: boolean;
  readonly position: number;
}

async function openField(
  keys: Keys,
  binding: ReturnType<typeof bindings.projectName>,
  envelope: string | null,
): Promise<{ readonly text: string | null; readonly readable: boolean }> {
  if (envelope === null) return { text: null, readable: true };
  try {
    return { text: await open(keys, binding, envelope), readable: true };
  } catch {
    return { text: null, readable: false };
  }
}

export async function fetchProjectEntries(
  client: ServerClient,
  keys: Keys,
): Promise<ProjectEntry[]> {
  const answer = await callRoute(client, listClientProjectsRoute, {});
  const entries = await Promise.all(
    answer.projects.map(async (project): Promise<ProjectEntry> => {
      const name = await openField(keys, bindings.projectName(project.id), project.name);
      const icon = await openField(keys, bindings.projectIcon(project.id), project.icon);
      const named = name.text !== null && name.text.trim() !== '';
      return {
        id: project.id,
        name: named ? name.text : null,
        label: !name.readable
          ? UNREADABLE_PROJECT_LABEL
          : named && name.text !== null
            ? name.text
            : DEFAULT_PROJECT_LABEL,
        icon: icon.text !== null && icon.text !== '' ? icon.text : null,
        isDefault: project.isDefault,
        archived: project.archivedAt !== null,
        position: project.position,
      };
    }),
  );
  return entries.sort((left, right) => left.position - right.position);
}

export async function fetchProjectNames(
  client: ServerClient,
  keys: Keys,
): Promise<Map<string, string>> {
  const entries = await fetchProjectEntries(client, keys);
  return new Map(entries.map((entry) => [entry.id, entry.label]));
}
