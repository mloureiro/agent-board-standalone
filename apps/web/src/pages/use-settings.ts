import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { isVersionConflict, loadDocument, saveDocument } from './documents.js';
import { usePage } from './use-page.js';

export const NOTIFICATIONS_SETTING = 'notifications.desktop';
export const RECENT_ICONS_SETTING = 'icons.recent';
export const RECENT_ICONS_LIMIT = 24;

export type SettingsValue = Readonly<Record<string, unknown>>;

export const SETTINGS_POLL_MS = 15_000;
const MAX_ATTEMPTS = 3;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const parseSettings = (text: string | null): SettingsValue => {
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

export const settingAt = (settings: SettingsValue, path: string): unknown => {
  if (path in settings) return settings[path];
  let current: unknown = settings;
  for (const part of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
};

export const withSetting = (
  settings: SettingsValue,
  path: string,
  value: unknown,
): SettingsValue => {
  const [head, ...rest] = path.split('.');
  if (head === undefined) return settings;
  if (rest.length === 0) return { ...settings, [head]: value };
  const child = settings[head];
  return {
    ...settings,
    [head]: withSetting(isRecord(child) ? child : {}, rest.join('.'), value),
  };
};

export interface SettingsData {
  readonly settings: SettingsValue | undefined;
  readonly offered: boolean;
  readonly failed: boolean;
  set(path: string, value: unknown): Promise<void>;
}

export function useSettings(): SettingsData | null {
  const page = usePage();
  const queryClient = useQueryClient();
  const offered = page?.features.includes('settings-document') === true;
  const key = [...(page?.base ?? []), 'settings-document'];

  const query = useQuery({
    queryKey: key,
    enabled: page !== null && offered,
    refetchInterval: SETTINGS_POLL_MS,
    queryFn: async (): Promise<SettingsValue> => {
      if (page === null) return {};
      return parseSettings((await loadDocument(page, 'settings')).text);
    },
  });

  const mutation = useMutation({
    mutationFn: async (change: { path: string; value: unknown }): Promise<SettingsValue> => {
      const current = page as NonNullable<typeof page>;
      for (let attempt = 1; ; attempt += 1) {
        const loaded = await loadDocument(current, 'settings');
        const next = withSetting(parseSettings(loaded.text), change.path, change.value);
        try {
          await saveDocument(current, 'settings', JSON.stringify(next), loaded.version);
          return next;
        } catch (error) {
          if (!isVersionConflict(error) || attempt >= MAX_ATTEMPTS) throw error;
        }
      }
    },
    onSuccess: (next) => queryClient.setQueryData(key, next),
  });

  if (page === null) return null;
  return {
    settings: query.data,
    offered,
    failed: query.isError,
    set: async (path, value) => void (await mutation.mutateAsync({ path, value })),
  };
}
