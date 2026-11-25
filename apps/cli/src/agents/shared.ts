import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getAgentsRoute, setAgentsRoute } from '@agent-board/contract';
import { bindings, open, seal } from '@agent-board/sealing';
import { stringify } from 'yaml';

import { configObject, editConfig, readConfigDocument } from '../config/file.js';
import { isRecord } from '../domain/values.js';
import { CliError } from '../errors.js';
import { writeAtomic } from '../profile/files.js';
import type { ProfileDirs } from '../profile/paths.js';
import { ApiError } from '../transport/errors.js';
import type { Session } from '../transport/session.js';
import { agentProblem, type AgentDefinition } from './definition.js';

export type SharedAgents = Record<string, AgentDefinition>;

const APPLIED_FILE = 'shared-agents.json';
export const ASIDE_DIR = 'agents.aside';

export function localAgents(configDir: string): SharedAgents {
  const agents = configObject(readConfigDocument(configDir)).agents;
  return isRecord(agents) ? (agents as SharedAgents) : {};
}

export async function readBoardAgents(
  s: Session,
): Promise<{ version: number; agents: SharedAgents; unreadable: boolean } | null> {
  if (!s.supports('shared-agents')) return null;
  const answer = await s.query(getAgentsRoute, {});
  if (answer.agents === null) return null;
  const { version, document } = answer.agents;
  try {
    const parsed: unknown = JSON.parse(
      await open(s.keys, bindings.sharedAgents(version), document),
    );
    const agents =
      isRecord(parsed) && isRecord(parsed.agents) ? (parsed.agents as SharedAgents) : {};
    return { version, agents, unreadable: false };
  } catch {
    return { version, agents: {}, unreadable: true };
  }
}

export async function writeBoardAgents(
  s: Session,
  current: { version: number } | null,
  agents: SharedAgents,
) {
  const expectedVersion = current?.version ?? 0;
  const version = expectedVersion + 1;
  try {
    await s.command(setAgentsRoute, {
      document: await seal(s.keys, bindings.sharedAgents(version), JSON.stringify({ agents })),
      version,
      expectedVersion,
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'version-conflict') {
      throw new CliError('the board agents changed meanwhile; run the command again');
    }
    throw error;
  }
}

export function appliedVersion(dirs: ProfileDirs): number {
  const file = path.join(dirs.state, APPLIED_FILE);
  if (!existsSync(file)) return 0;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isRecord(parsed) && typeof parsed.version === 'number' ? parsed.version : 0;
  } catch {
    return 0;
  }
}

export interface AppliedAgents {
  readonly version: number;
  readonly added: readonly string[];
  readonly replaced: readonly string[];
}

export async function applyBoardAgents(
  s: Session,
  dirs: ProfileDirs,
  say: (line: string) => void,
  now: () => Date = () => new Date(),
): Promise<AppliedAgents | null> {
  if (s.dryRun || !s.supports('shared-agents')) return null;
  if (s.info.agentsVersion === null || appliedVersion(dirs) >= s.info.agentsVersion) return null;
  const board = await readBoardAgents(s);
  if (board === null) return null;
  if (board.unreadable) {
    say(
      `the board agents (version ${board.version}) cannot be decrypted with this data key; not applied`,
    );
    return null;
  }
  const local = localAgents(dirs.config);
  const added: string[] = [];
  const replaced: string[] = [];
  const next: SharedAgents = { ...local };
  for (const [name, definition] of Object.entries(board.agents)) {
    const problem = agentProblem(name, definition);
    if (problem !== null) {
      say(`board agent ${name} not applied: ${problem}`);
      continue;
    }
    const existing = local[name];
    if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(definition)) continue;
    if (existing !== undefined) {
      const aside = path.join(dirs.config, ASIDE_DIR);
      mkdirSync(aside, { recursive: true, mode: 0o700 });
      const stamp = now().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
      writeFileSync(path.join(aside, `${name}-${stamp}.yaml`), stringify(existing), {
        mode: 0o600,
      });
      replaced.push(name);
    } else added.push(name);
    next[name] = definition;
  }
  if (added.length + replaced.length > 0) {
    editConfig(dirs.config, (document) => {
      document.set('agents', next);
    });
  }
  writeAtomic(
    path.join(dirs.state, APPLIED_FILE),
    `${JSON.stringify({ version: board.version })}\n`,
    0o600,
  );
  for (const name of added) say(`added board agent ${name}`);
  for (const name of replaced)
    say(`replaced local agent ${name} with the board's; the old one is in ${ASIDE_DIR}`);
  return { version: board.version, added, replaced };
}
