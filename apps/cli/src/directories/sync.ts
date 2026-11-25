import { setDirsRoute } from '@agent-board/contract';
import { bindings, seal } from '@agent-board/sealing';

import type { Session } from '../transport/session.js';
import type { LocalDirectories, LocalDirectory } from './local.js';

export interface MachineDirectory extends LocalDirectory {
  readonly projectId: string | null;
}

export async function machineDirectories(
  session: Session,
  local: LocalDirectories,
): Promise<MachineDirectory[]> {
  const unknown = local.entries.map((entry) => ({ ...entry, projectId: null }));
  if (!local.configured || session.dryRun || !session.supports('directories')) return unknown;
  const answer = await session.command(setDirsRoute, {
    directories: await Promise.all(
      local.entries.map(async (entry) => ({
        id: entry.id,
        path: await seal(session.keys, bindings.directoryPath(entry.id), entry.path),
        repo:
          entry.repo === null
            ? null
            : await seal(session.keys, bindings.directoryRepo(entry.id), entry.repo),
      })),
    ),
  });
  if (answer === null) return unknown;
  const projects = new Map(answer.directories.map((row) => [row.id, row.projectId]));
  return local.entries.map((entry) => ({ ...entry, projectId: projects.get(entry.id) ?? null }));
}
