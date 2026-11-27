import { agentName, modelName } from '@rumo/contract';

import { isRecord, isStringList, nearest } from '../domain/values.js';

export const AGENT_KEYS = [
  'description',
  'prompt',
  'tools',
  'allowedTools',
  'disallowedTools',
  'mcpServers',
  'env',
  'model',
  'version',
  'source',
] as const;

export type AgentKey = (typeof AGENT_KEYS)[number];

export interface AgentDefinition {
  readonly description: string;
  readonly prompt?: string;
  readonly tools: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly env?: readonly string[];
  readonly model?: string;
  readonly version?: string;
  readonly source?: string;
}

export const AGENT_NAME_RULE =
  'lowercase letters, digits and dashes, at most 32 characters, starting with a letter or a digit';

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_:.*-]*$/;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_TEXT = 2000;

export function isAgentName(value: string): boolean {
  return agentName.safeParse(value).success;
}

function oneLine(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length <= MAX_TEXT &&
    [...value].every((char) => char >= ' ' && char !== '\x7f')
  );
}

export function agentProblem(name: string, entry: unknown): string | null {
  const where = `agents.${name}`;
  if (!isAgentName(name)) return `the agent name "${name.slice(0, 40)}" must be ${AGENT_NAME_RULE}`;
  if (!isRecord(entry)) return `${where} must be an object`;
  for (const key of Object.keys(entry)) {
    if ((AGENT_KEYS as readonly string[]).includes(key)) continue;
    const near = nearest(key, AGENT_KEYS);
    return `${where} has no key "${key.slice(0, 40)}"${
      near === undefined ? `; it takes ${AGENT_KEYS.join(', ')}` : `; did you mean "${near}"?`
    }`;
  }
  const { description, prompt, model, tools, env, mcpServers } = entry;
  if (typeof description !== 'string' || description.trim() === '') {
    return `${where}.description must be a non-empty string`;
  }
  if (prompt !== undefined && typeof prompt !== 'string') return `${where}.prompt must be a string`;
  if (model !== undefined && (typeof model !== 'string' || !modelName.safeParse(model).success)) {
    return `${where}.model must be a model name`;
  }
  for (const key of ['version', 'source'] as const) {
    if (entry[key] !== undefined && !oneLine(entry[key]))
      return `${where}.${key} must be one line of text`;
  }
  for (const key of ['tools', 'allowedTools', 'disallowedTools', 'mcpServers', 'env'] as const) {
    if (entry[key] !== undefined && !isStringList(entry[key])) {
      return `${where}.${key} must be a list of strings`;
    }
  }
  if (!isStringList(tools) || tools.length === 0) {
    return `${where}.tools must be a non-empty list of tool names`;
  }
  const badTool = tools.find((tool) => !TOOL_NAME.test(tool));
  if (badTool !== undefined) {
    return `${where}.tools names "${badTool.slice(0, 40)}", which is not a tool name; rules with arguments belong in allowedTools`;
  }
  for (const key of ['allowedTools', 'disallowedTools'] as const) {
    const rules = entry[key];
    const bad = isStringList(rules)
      ? rules.find((rule) => rule.trim() === '' || rule.startsWith('-'))
      : undefined;
    if (bad !== undefined) return `${where}.${key} takes tool rules, not "${bad.slice(0, 40)}"`;
  }
  if (isStringList(mcpServers) && mcpServers.some((server) => server.trim() === '')) {
    return `${where}.mcpServers must name servers`;
  }
  const badVariable = isStringList(env)
    ? env.find((variable) => !VARIABLE_NAME.test(variable))
    : undefined;
  if (badVariable !== undefined) {
    return `${where}.env names "${badVariable.slice(0, 40)}", which is not a variable name`;
  }
  return null;
}

export function agentsProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'agents must be an object keyed by agent name';
  for (const [name, entry] of Object.entries(value)) {
    const problem = agentProblem(name, entry);
    if (problem !== null) return problem;
  }
  return null;
}
