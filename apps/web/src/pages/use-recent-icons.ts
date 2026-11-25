import {
  RECENT_ICONS_LIMIT,
  RECENT_ICONS_SETTING,
  settingAt,
  useSettings,
} from './use-settings.js';

export interface RecentIcons {
  readonly icons: readonly string[];
  record(icon: string): void;
}

export const pushRecent = (icons: readonly string[], icon: string): readonly string[] =>
  [icon, ...icons.filter((entry) => entry !== icon)].slice(0, RECENT_ICONS_LIMIT);

export function useRecentIcons(): RecentIcons {
  const data = useSettings();
  const stored = data?.settings === undefined ? [] : settingAt(data.settings, RECENT_ICONS_SETTING);
  const icons = Array.isArray(stored)
    ? stored.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : [];
  return {
    icons,
    record: (icon) => {
      if (data === null || !data.offered || data.settings === undefined || icon === '') return;
      void data.set(RECENT_ICONS_SETTING, pushRecent(icons, icon)).catch(() => undefined);
    },
  };
}
