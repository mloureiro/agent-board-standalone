import type { FeedAction, RouteResponse, listClientFeedsRoute } from '@rumo/contract';
import { bindings, type Keys } from '@rumo/sealing';

import { attempt } from '../board/card-model.js';

type UiMachineFeeds = RouteResponse<typeof listClientFeedsRoute>['machines'][number];

export interface Feed {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly paused: boolean;
}

export interface MachineFeeds {
  readonly name: string;
  readonly feeds: readonly Feed[];
  readonly requests: readonly string[];
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const parseFeeds = (text: string | null): readonly Feed[] => {
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = record(parsed).feeds;
  if (!Array.isArray(list)) return [];
  const feeds: Feed[] = [];
  for (const entry of list) {
    const { id, name, status, paused } = record(entry);
    if (typeof id !== 'string' || typeof name !== 'string') continue;
    const isPaused = paused === true || status === 'paused';
    feeds.push({
      id,
      name,
      paused: isPaused,
      status: typeof status === 'string' ? status : isPaused ? 'paused' : 'idle',
    });
  }
  return feeds;
};

export async function decryptFeeds(keys: Keys, machine: UiMachineFeeds): Promise<MachineFeeds> {
  const text = await attempt(
    keys,
    bindings.machineDocument('machine.feeds', machine.name),
    machine.feeds,
  );
  return { name: machine.name, feeds: parseFeeds(text), requests: machine.feedRequests };
}

export const requestKey = (action: FeedAction, id: string): string => `${action}:${id}`;
