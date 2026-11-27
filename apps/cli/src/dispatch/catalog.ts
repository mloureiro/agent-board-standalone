import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { setCatalogRoute } from '@rumo/contract';
import { bindings, blindIndex, seal } from '@rumo/sealing';
import { parse } from 'yaml';

import type { Runtime } from '../runtime.js';
import type { Session } from '../transport/session.js';

export interface CatalogSkill {
  readonly name: string;
  readonly description: string | null;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

function skillOf(folder: string, file: string): CatalogSkill | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const head = FRONT_MATTER.exec(text)?.[1];
  let meta: unknown;
  try {
    meta = head === undefined ? null : parse(head);
  } catch {
    meta = null;
  }
  const { name, description } =
    meta !== null && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
  return {
    name: typeof name === 'string' && name !== '' ? name : folder,
    description: typeof description === 'string' && description !== '' ? description : null,
  };
}

export function readSkills(root: string): CatalogSkill[] {
  const skillsDir = path.join(root, 'skills');
  if (!existsSync(skillsDir)) return [];
  let folders: string[];
  try {
    folders = readdirSync(skillsDir).sort();
  } catch {
    return [];
  }
  return folders.flatMap((folder) => {
    const skill = skillOf(folder, path.join(skillsDir, folder, 'SKILL.md'));
    return skill === null ? [] : [skill];
  });
}

export function catalogDocument(
  rt: Pick<Runtime, 'env' | 'homedir'>,
  directories: readonly string[],
): string {
  const configured = rt.env.CLAUDE_CONFIG_DIR;
  const root =
    configured !== undefined && configured !== '' ? configured : path.join(rt.homedir, '.claude');
  const dirs: Record<string, CatalogSkill[]> = {};
  for (const directory of directories) {
    const skills = readSkills(path.join(directory, '.claude'));
    if (skills.length > 0) dirs[directory] = skills;
  }
  return JSON.stringify({ skills: readSkills(root), dirs });
}

export async function sendCatalog(
  s: Session,
  rt: Pick<Runtime, 'env' | 'homedir'>,
  directories: readonly string[],
): Promise<boolean> {
  if (s.dryRun) return false;
  const document = catalogDocument(rt, directories);
  const index = await blindIndex(s.keys, `catalog:${s.machine}:${document}`);
  if (index === s.info.catalogIndex) return false;
  await s.command(setCatalogRoute, {
    catalog: await seal(s.keys, bindings.machineDocument('machine.catalog', s.machine), document),
    index,
  });
  return true;
}
