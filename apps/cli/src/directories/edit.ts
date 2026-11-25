import { editConfig } from '../config/file.js';
import type { LocalDirectory } from './local.js';

function plain(entry: LocalDirectory): Record<string, unknown> {
  return {
    id: entry.id,
    path: entry.path,
    ...(entry.repo === null ? {} : { repo: entry.repo }),
    ...(entry.isDefault ? { default: true } : {}),
    ...(entry.label === null ? {} : { label: entry.label }),
    ...(entry.lane === null ? {} : { lane: entry.lane }),
    ...(entry.ciIgnore.length === 0 ? {} : { ciIgnore: [...entry.ciIgnore] }),
  };
}

export function writeDirectories(configDir: string, entries: readonly LocalDirectory[]): void {
  editConfig(configDir, (document) => {
    document.set('dirs', entries.map(plain));
  });
}

export function writeDefaultProject(configDir: string, project: string | null): void {
  editConfig(configDir, (document) => {
    if (project === null) document.delete('project');
    else document.set('project', project);
  });
}
