import { isRecord } from '../domain/values.js';

export const MAX_ITEMS = 200;
const KEY = /^[A-Za-z0-9._:/#@+-]{1,200}$/;

export interface FeedItem {
  readonly key: string;
  readonly title: string | undefined;
  readonly prompt: string;
  readonly version: string | undefined;
}

export function parseItems(output: string): FeedItem[] | string {
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    return 'the integration printed no JSON';
  }
  const list = isRecord(raw) ? raw.items : undefined;
  if (!Array.isArray(list)) return 'the integration must print {"items": [...]}';
  if (list.length > MAX_ITEMS) return `the integration listed more than ${MAX_ITEMS} items`;
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  for (const entry of list as unknown[]) {
    if (!isRecord(entry)) return 'an item must be an object';
    const { key, title, prompt, version } = entry;
    if (typeof key !== 'string' || !KEY.test(key))
      return 'an item needs a key of plain characters (at most 200)';
    if (seen.has(key)) return `the item key "${key.slice(0, 40)}" is listed twice`;
    seen.add(key);
    if (typeof prompt !== 'string' || prompt.trim() === '')
      return `item ${key.slice(0, 40)} has no prompt`;
    if (title !== undefined && typeof title !== 'string')
      return `item ${key.slice(0, 40)} has a title that is not text`;
    if (version !== undefined && typeof version !== 'string')
      return `item ${key.slice(0, 40)} has a version that is not text`;
    items.push({ key, prompt, title, version });
  }
  return items;
}
