import { CliError } from '../errors.js';
import type { AgentDefinition } from '../agents/definition.js';
import { BOARD_RULES } from './messages.js';
import type { RunPlan } from './plan.js';

export const USER_PERMISSION_MODE = 'auto';
export const AGENT_PERMISSION_MODE = 'dontAsk';

type Resumable = Exclude<RunPlan, { kind: 'blocked' }>;

export interface InvocationInput {
  readonly run: Resumable;
  readonly model: string | null;
  readonly effort: string | null;
  readonly hookCommand: string;
  readonly home: string;
  readonly agent?: { readonly name: string; readonly definition: AgentDefinition } | undefined;
  readonly agentsPath?: string | undefined;
}

export interface AgentsFile {
  readonly path: string;
  readonly content: string;
}

export interface Invocation {
  readonly args: string[];
  readonly agentsFile?: AgentsFile;
}

export function expandRule(rule: string, home: string): string {
  return rule.startsWith('Bash(') ? rule.replaceAll('~/', `${home}/`) : rule;
}

function sessionArguments(run: Resumable): string[] {
  if (run.kind === 'resume') return ['--resume', run.sessionId];
  if (run.kind === 'fork') {
    return ['--resume', run.fromSessionId, '--fork-session', '--session-id', run.sessionId];
  }
  return ['--session-id', run.sessionId];
}

export function claudeArguments(input: InvocationInput): Invocation {
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: input.hookCommand }] }],
    },
  };
  const args = [
    '-p',
    ...sessionArguments(input.run),
    ...(input.model === null ? [] : ['--model', input.model]),
    ...(input.effort === null ? [] : ['--effort', input.effort]),
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    BOARD_RULES,
    '--settings',
    JSON.stringify(settings),
  ];
  const { agent } = input;
  if (agent === undefined) {
    args.push('--permission-mode', USER_PERMISSION_MODE);
    return { args };
  }
  const allowed = (agent.definition.allowedTools ?? []).map((rule) => expandRule(rule, input.home));
  const denied = (agent.definition.disallowedTools ?? []).map((rule) =>
    expandRule(rule, input.home),
  );
  const optionLike = [...allowed, ...denied].find((rule) => rule.startsWith('-'));
  if (optionLike !== undefined) {
    throw new CliError(
      `a tool rule of agent ${agent.name} starts with "-" and would be read as an option: ${optionLike.slice(0, 40)}`,
    );
  }
  if (input.agentsPath === undefined)
    throw new CliError('an agent run needs a file for its definition');
  args.push(
    `--tools=${agent.definition.tools.filter((tool) => !tool.startsWith('mcp__')).join(',')}`,
    '--agents',
    input.agentsPath,
    '--agent',
    agent.name,
    '--permission-mode',
    AGENT_PERMISSION_MODE,
    '--setting-sources',
    'user',
  );
  if (allowed.length > 0) args.push('--allowedTools', ...allowed);
  if (denied.length > 0) args.push('--disallowedTools', ...denied);
  return {
    args,
    agentsFile: {
      path: input.agentsPath,
      content: JSON.stringify({
        [agent.name]: {
          description: agent.definition.description,
          prompt: agent.definition.prompt ?? '',
          tools: agent.definition.tools,
          ...(agent.definition.model === undefined ? {} : { model: agent.definition.model }),
        },
      }),
    },
  };
}
