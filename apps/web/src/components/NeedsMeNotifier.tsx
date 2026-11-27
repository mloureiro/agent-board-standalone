import { clientAttentionRoute, getClientTaskRoute, listClientTasksRoute } from '@rumo/contract';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, type ReactNode } from 'react';

import { currentBridge } from '../bridge/index.js';
import { useNotificationPermission } from './notification-permission.js';
import { NOTIFICATIONS_SETTING, settingAt, usePage, useSettings } from '../pages/index.js';
import { useEnvironment } from '../session/index.js';
import { attemptTaskField } from '../routes/board/card-model.js';

export const ATTENTION_POLL_MS = 3_000;

interface Waiting {
  readonly id: string;
  readonly title: string;
}

export const windowInFront = (): boolean => document.hasFocus() && !document.hidden;

export function NeedsMeNotifier(): ReactNode {
  const page = usePage();
  const settings = useSettings();
  const environment = useEnvironment();
  const known = useRef<ReadonlySet<string> | null>(null);
  const titles = useRef(new Map<string, string>());
  const native = currentBridge();
  const [permission] = useNotificationPermission();
  const serverId = page?.serverId ?? null;
  const enabled =
    settings?.settings !== undefined &&
    settingAt(settings.settings, NOTIFICATIONS_SETTING) === true &&
    (native !== null || permission === 'granted');

  const settingsLoaded = settings?.settings !== undefined;
  useEffect(() => {
    if (native?.setNotifications === undefined || serverId === null || !settingsLoaded) return;
    void native.setNotifications(serverId, enabled).catch(() => undefined);
  }, [native, serverId, settingsLoaded, enabled]);

  const waiting = useQuery({
    queryKey: [...(page?.base ?? []), 'needs-me'],
    enabled: page !== null && enabled,
    refetchInterval: ATTENTION_POLL_MS,
    refetchIntervalInBackground: true,
    queryFn: async (): Promise<Waiting[]> => {
      if (page === null) return [];
      if (page.features.includes('attention')) {
        const { tasks } = await page.call(clientAttentionRoute, {});
        return Promise.all(
          tasks.map(async ({ id }) => {
            const cached = titles.current.get(id);
            if (cached !== undefined) return { id, title: cached };
            const detail = await page.call(getClientTaskRoute, { id }).catch(() => null);
            if (detail === null) return { id, title: 'A task' };
            const title =
              (await attemptTaskField(page.keys, 'title', detail.task, detail.task.title)) ??
              'A task';
            titles.current.set(id, title);
            return { id, title };
          }),
        );
      }
      const answer = await page.call(listClientTasksRoute, {});
      const needing = answer.tasks.filter((task) => task.status === 'needs-me');
      return Promise.all(
        needing.map(async (task) => ({
          id: task.id,
          title: (await attemptTaskField(page.keys, 'title', task, task.title)) ?? 'A task',
        })),
      );
    },
  });

  useEffect(() => {
    if (!enabled) {
      known.current = null;
      return;
    }
    if (waiting.data === undefined || serverId === null) return;
    const previous = known.current;
    known.current = new Set(waiting.data.map((task) => task.id));
    if (previous === null || windowInFront()) return;
    for (const task of waiting.data) {
      if (previous.has(task.id)) continue;
      if (native !== null) {
        void native.notify({ serverId, taskId: task.id, title: task.title });
        continue;
      }
      const notification = new Notification(task.title, {
        body: 'Needs you',
        tag: task.id,
      });
      notification.onclick = () => {
        window.focus();
        environment.assign(`/tasks/${task.id}`);
      };
    }
  }, [waiting.data, enabled, native, serverId, environment]);

  return null;
}
