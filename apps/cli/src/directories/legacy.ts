import { randomUUID } from 'node:crypto';

import { convertLegacyDirsRoute, getLegacyDirsRoute } from '@agent-board/contract';
import { bindings, open, seal } from '@agent-board/sealing';

import { isRecord } from '../domain/values.js';
import type { Session } from '../transport/session.js';
import { writeDirectories } from './edit.js';
import { normalizePath, readLocalDirectories, type LocalDirectory } from './local.js';

export interface LegacyUse {
  readonly kind: 'task' | 'schedule';
  readonly id: string;
}

export interface LegacyReport {
  readonly matched: number;
  readonly unmatched: readonly LegacyUse[];
}

async function attempt(session: Session, binding: Parameters<typeof open>[1], text: string) {
  try {
    return await open(session.keys, binding, text);
  } catch {
    return null;
  }
}

async function documentPaths(session: Session, document: string | null): Promise<string[]> {
  if (document === null) return [];
  const text = await attempt(
    session,
    bindings.machineDocument('machine.dirs', session.machine),
    document,
  );
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const listed = isRecord(parsed) ? parsed.dirs : undefined;
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((entry) =>
    isRecord(entry) && typeof entry.path === 'string' && entry.path.startsWith('/')
      ? [normalizePath(entry.path)]
      : [],
  );
}

function legacyBinding(use: { kind: 'task' | 'schedule'; id: string }) {
  return bindings.workdir(use.kind === 'task' ? { task: use.id } : { schedule: use.id });
}

export async function convertLegacyDirectories(
  session: Session,
  configDir: string,
): Promise<LegacyReport | null> {
  if (session.dryRun || !session.info.legacyDirs || !session.supports('legacy-dirs')) return null;
  const legacy = await session.query(getLegacyDirsRoute, {});
  const local = readLocalDirectories(configDir);

  const idByPath = new Map(local.entries.map((entry) => [normalizePath(entry.path), entry.id]));
  const added: LocalDirectory[] = [];
  for (const documented of await documentPaths(session, legacy.document)) {
    if (idByPath.has(documented)) continue;
    const id = randomUUID();
    idByPath.set(documented, id);
    added.push({
      id,
      path: documented,
      repo: null,
      isDefault: false,
      label: null,
      lane: null,
      ciIgnore: [],
    });
  }

  const assign: { kind: 'task' | 'schedule'; id: string; directoryId: string }[] = [];
  const unmatched: LegacyUse[] = [];
  for (const use of legacy.tasks) {
    const text = await attempt(session, legacyBinding(use), use.legacyDirectory);
    const directoryId = text === null ? undefined : idByPath.get(normalizePath(text));
    if (directoryId === undefined) unmatched.push({ kind: use.kind, id: use.id });
    else assign.push({ kind: use.kind, id: use.id, directoryId });
  }

  const entries = [...local.entries, ...added];
  if (added.length > 0) writeDirectories(configDir, entries);
  await session.command(convertLegacyDirsRoute, {
    directories: await Promise.all(
      entries.map(async (entry) => ({
        id: entry.id,
        path: await seal(session.keys, bindings.directoryPath(entry.id), entry.path),
        repo:
          entry.repo === null
            ? null
            : await seal(session.keys, bindings.directoryRepo(entry.id), entry.repo),
      })),
    ),
    assign,
  });
  return { matched: assign.length, unmatched };
}

export function reportLegacy(report: LegacyReport, say: (line: string) => void): void {
  say(
    `legacy directories: ${report.matched} matched, ${report.unmatched.length} unmatched${
      report.unmatched.length === 0 ? '' : ' (they keep no directory until you set one)'
    }`,
  );
  for (const use of report.unmatched) say(`  unmatched ${use.kind} ${use.id}`);
}
