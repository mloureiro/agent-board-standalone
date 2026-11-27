import { laneName, MIN_INTERVAL_MS } from '@rumo/contract';
import path from 'node:path';

import { nearest, isRecord } from '../domain/values.js';
import { isAgentName } from '../agents/definition.js';
import { formatDuration, parseDuration } from '../domain/time.js';
import { UsageError } from '../errors.js';

export const MAX_FEEDS = 30;
export const FEED_KEYS = ['integration', 'action', 'every', 'dir', 'agent', 'lane'] as const;
export const FEED_NAME_RULE =
  'lowercase letters, digits and dashes, at most 40 characters, starting with a letter or a digit';

const FEED_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const INTEGRATION_REF = /^[a-z0-9][a-z0-9-]{0,39}:[a-z0-9][a-z0-9-]{0,39}$/;
const ACTION_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface FeedConfig {
  readonly name: string;
  readonly integration: string;
  readonly action: string;
  readonly everyMs: number;
  readonly dir: string;
  readonly agent?: string;
  readonly lane?: string;
}

export function isFeedName(value: string): boolean {
  return FEED_NAME.test(value);
}

export function parseFeed(name: string, entry: unknown): FeedConfig | string {
  const where = `feeds.${name}`;
  if (!isFeedName(name)) return `a feed name must be ${FEED_NAME_RULE}`;
  if (!isRecord(entry)) return `${where} must be an object`;
  for (const key of Object.keys(entry)) {
    if ((FEED_KEYS as readonly string[]).includes(key)) continue;
    const near = nearest(key, FEED_KEYS);
    return `${where} has no key "${key.slice(0, 40)}"${
      near === undefined ? `; it takes ${FEED_KEYS.join(', ')}` : `; did you mean "${near}"?`
    }`;
  }
  const { integration, action, every, dir, agent, lane } = entry;
  if (typeof integration !== 'string' || !INTEGRATION_REF.test(integration)) {
    return `${where}.integration must be <marketplace>:<integration>, as installed with rumo plugins`;
  }
  if (typeof action !== 'string' || !ACTION_NAME.test(action)) {
    return `${where}.action must be an action name of the integration`;
  }
  if (typeof every !== 'string') return `${where}.every must be a duration such as 10m or 2h`;
  let everyMs: number;
  try {
    everyMs = parseDuration(every);
  } catch (error) {
    return `${where}.every: ${error instanceof UsageError ? error.message : 'not a duration'}`;
  }
  if (everyMs < MIN_INTERVAL_MS)
    return `${where}.every must be at least ${formatDuration(MIN_INTERVAL_MS)}`;
  if (typeof dir !== 'string' || !path.isAbsolute(dir))
    return `${where}.dir must be an absolute path`;
  if (agent !== undefined && (typeof agent !== 'string' || !isAgentName(agent))) {
    return `${where}.agent must be an agent name`;
  }
  if (lane !== undefined && (typeof lane !== 'string' || !laneName.safeParse(lane).success)) {
    return `${where}.lane must be a lane name`;
  }
  return {
    name,
    integration,
    action,
    everyMs,
    dir,
    ...(agent === undefined ? {} : { agent: agent as string }),
    ...(lane === undefined ? {} : { lane: lane as string }),
  };
}

export function feedsProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'feeds must be an object keyed by feed name';
  if (Object.keys(value).length > MAX_FEEDS) return `a machine runs at most ${MAX_FEEDS} feeds`;
  for (const [name, entry] of Object.entries(value)) {
    const parsed = parseFeed(name, entry);
    if (typeof parsed === 'string') return parsed;
  }
  return null;
}
