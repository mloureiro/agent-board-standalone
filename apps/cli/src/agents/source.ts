import { createHash } from 'node:crypto';
import path from 'node:path';

import { parse } from 'yaml';

import { UsageError } from '../errors.js';
import { readTextFile } from '../input/text-file.js';
import type { Runtime } from '../runtime.js';
import { isAgentName, agentProblem, type AgentDefinition } from './definition.js';
import { EXAMPLES } from './examples.js';
import { isRecord } from '../domain/values.js';

export const MAX_AGENT_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export interface AgentSource {
  readonly name: string | undefined;
  readonly definition: AgentDefinition;
  readonly origin: string;
}

async function fetchUrl(rt: Runtime, given: string): Promise<{ text: string; url: URL }> {
  const [location = '', pin] = given.split('#sha256=');
  let url = new URL(location);
  if (url.protocol !== 'https:') throw new UsageError('an agent URL must be https');
  for (let hops = 0; hops <= MAX_REDIRECTS; hops += 1) {
    const response = await rt.fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const next = new URL(response.headers.get('location') ?? '', url);
      if (next.protocol !== 'https:' || next.host !== url.host) {
        throw new UsageError(
          `the agent URL redirects to ${next.host}; only same-host https redirects are followed`,
        );
      }
      url = next;
      continue;
    }
    if (!response.ok) throw new UsageError(`${url.host} answered ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_AGENT_BYTES) {
      throw new UsageError(`the agent document is larger than ${MAX_AGENT_BYTES / 1024} KB`);
    }
    if (pin !== undefined) {
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== pin.toLowerCase()) {
        throw new UsageError(`the agent document does not match the pinned sha256 (got ${digest})`);
      }
    }
    return { text: new TextDecoder().decode(bytes), url };
  }
  throw new UsageError('the agent URL redirects too many times');
}

function stem(value: string): string {
  return path.basename(value).replace(/\.(ya?ml|json)$/i, '');
}

export function parseAgentText(
  text: string,
  fallbackName: string | undefined,
  origin: string,
): AgentSource {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    throw new UsageError('the agent document is not valid YAML or JSON');
  }
  if (!isRecord(parsed)) throw new UsageError('the agent document must be an object');
  const { name: named, ...rest } = parsed;
  if (named !== undefined && typeof named !== 'string')
    throw new UsageError('the agent name must be text');
  const name = named ?? fallbackName;
  const problem = agentProblem('agent', rest);
  if (problem !== null) throw new UsageError(problem);
  return { name, definition: rest as unknown as AgentDefinition, origin };
}

export async function loadAgentSource(rt: Runtime, given: string): Promise<AgentSource> {
  if (given.startsWith('example:')) {
    const name = given.slice('example:'.length);
    const example = EXAMPLES[name];
    if (example === undefined) {
      throw new UsageError(
        `no example "${name.slice(0, 40)}"; the examples are ${Object.keys(EXAMPLES).join(', ')}`,
      );
    }
    return { name, definition: { ...example, source: given }, origin: given };
  }
  if (given.startsWith('https://') || given.startsWith('http://')) {
    const { text, url } = await fetchUrl(rt, given);
    const source = parseAgentText(text, stem(url.pathname), url.href);
    return {
      ...source,
      definition: {
        ...source.definition,
        source: source.definition.source ?? `${url.origin}${url.pathname}`,
      },
    };
  }
  if (given === '-') return parseAgentText(await rt.readStdin(), undefined, 'stdin');
  const file = path.resolve(rt.cwd(), given);
  return parseAgentText(readTextFile(file, MAX_AGENT_BYTES), stem(file), file);
}

export function checkedName(name: string | undefined): string {
  if (name === undefined || !isAgentName(name)) {
    throw new UsageError(
      'the agent needs a name: put "name:" in the document, or pass --name (lowercase letters, digits and dashes)',
    );
  }
  return name;
}
