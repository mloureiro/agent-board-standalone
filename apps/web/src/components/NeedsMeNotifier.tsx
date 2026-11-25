import { listClientTasksRoute } from '@agent-board/contract';
import { bindings } from '@agent-board/sealing';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, type ReactNode } from 'react';

import { currentBridge } from '../bridge/index.js';
import { NOTIFICATIONS_SETTING, settingAt, usePage, useSettings } from '../pages/index.js';
import { useEnvironment } from '../session/index.js';
import { attempt } from '../routes/board/card-model.js';

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
  const native = currentBridge();
  const serverId = page?.serverId ?? null;
  const enabled =
    settings?.settings !== undefined &&
    settingAt(settings.settings, NOTIFICATIONS_SETTING) === true &&
    (native !== null ||
      (typeof Notification !== 'undefined' && Notification.permission === 'granted'));

  const settingsLoaded = settings?.settings !== undefined;
  useEffect(() => {
    if (native?.setNotifications === undefined || serverId === null || !settingsLoaded) return;
    void native.setNotifications(serverId, enabled).catch(() => undefined);
  }, [native, serverId, settingsLoaded, enabled]);

  const waiting = useQuery({
    queryKey: [...(page?.base ?? []), 'needs-me'],
    enabled: page !== null && enabled,
    refetchInterval: ATTENTION_POLL_MS,
    queryFn: async (): Promise<Waiting[]> => {
      if (page === null) return [];
      const answer = await page.call(listClientTasksRoute, {});
      const needing = answer.tasks.filter((task) => task.status === 'needs-me');
      return Promise.all(
        needing.map(async (task) => ({
          id: task.id,
          title:
            (await attempt(page.keys, bindings.title({ task: task.id }), task.title)) ?? 'A task',
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
