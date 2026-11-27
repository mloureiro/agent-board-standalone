import { setDirsRoute } from '@rumo/contract';
import { bindings, seal } from '@rumo/sealing';

import type { Session } from '../transport/session.js';
import { convertLegacyDirectories, reportLegacy } from './legacy.js';
import { readLocalDirectories, type LocalDirectories, type LocalDirectory } from './local.js';

export interface MachineDirectory extends LocalDirectory {
  readonly projectId: string | null;
}

export interface SyncOptions {
  readonly configDir: string;
  readonly say: (line: string) => void;
  readonly placeIn?: ReadonlyMap<string, string>;
}

export async function machineDirectories(
  session: Session,
  local: LocalDirectories,
  placeIn: ReadonlyMap<string, string> = new Map(),
): Promise<MachineDirectory[]> {
  const unknown = local.entries.map((entry) => ({ ...entry, projectId: null }));
  if (!local.configured || session.dryRun || !session.supports('directories')) return unknown;
  const answer = await session.command(setDirsRoute, {
    directories: await Promise.all(
      local.entries.map(async (entry) => {
        const project = placeIn.get(entry.id);
        return {
          id: entry.id,
          path: await seal(session.keys, bindings.directoryPath(entry.id), entry.path),
          repo:
            entry.repo === null
              ? null
              : await seal(session.keys, bindings.directoryRepo(entry.id), entry.repo),
          ...(project === undefined ? {} : { projectId: project }),
        };
      }),
    ),
  });
  if (answer === null) return unknown;
  const projects = new Map(answer.directories.map((row) => [row.id, row.projectId]));
  return local.entries.map((entry) => ({ ...entry, projectId: projects.get(entry.id) ?? null }));
}

export async function syncDirectories(
  session: Session,
  options: SyncOptions,
): Promise<{ local: LocalDirectories; rows: MachineDirectory[] }> {
  const report = await convertLegacyDirectories(session, options.configDir);
  if (report !== null) reportLegacy(report, options.say);
  const local = readLocalDirectories(options.configDir);
  return { local, rows: await machineDirectories(session, local, options.placeIn) };
}
