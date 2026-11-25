import { Alert, Checkbox, Stack, Text } from '@mantine/core';
import { useState, type ReactNode } from 'react';

import { currentBridge } from '../../bridge/index.js';
import { NOTIFICATIONS_SETTING, settingAt, useSettings } from '../../pages/index.js';
import { notOffered } from '../../servers/index.js';

export const NO_SETTINGS = notOffered('settings-document');

export type Permission = 'granted' | 'denied' | 'default' | 'unsupported';

export const permissionOf = (): Permission =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

const PERMISSION_TEXT: Readonly<Record<Permission, string | null>> = {
  granted: null,
  default: 'This browser has not allowed notifications yet. It asks when you turn them on.',
  denied: 'This browser blocks notifications for this site. Allow them in the browser settings.',
  unsupported: 'This browser cannot show notifications.',
};

export function NotificationsPanel(): ReactNode {
  const data = useSettings();
  const [permission, setPermission] = useState<Permission>(permissionOf);
  const [error, setError] = useState<string | null>(null);
  if (data === null) return null;
  if (!data.offered) return <Text c="dimmed">{NO_SETTINGS}</Text>;
  const enabled =
    data.settings !== undefined && settingAt(data.settings, NOTIFICATIONS_SETTING) === true;
  const native = currentBridge() !== null;

  const change = (next: boolean): void => {
    setError(null);
    const ask =
      next && !native && permission === 'default' && typeof Notification !== 'undefined'
        ? Notification.requestPermission().then((answer) => setPermission(answer))
        : Promise.resolve();
    void ask
      .then(() => data.set(NOTIFICATIONS_SETTING, next))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'The setting could not be saved.'),
      );
  };

  return (
    <Stack gap="sm" maw={480}>
      <Checkbox
        label="Notifications"
        description="Show a notification when a task needs you and this window is not in front. The setting follows you to your other devices. Each browser keeps its own permission."
        checked={enabled}
        disabled={data.settings === undefined}
        onChange={(event) => change(event.currentTarget.checked)}
      />
      {!native && PERMISSION_TEXT[permission] !== null ? (
        <Text size="sm" c="dimmed">
          {PERMISSION_TEXT[permission]}
        </Text>
      ) : null}
      {error === null ? null : (
        <Alert color="red" role="alert">
          {error}
        </Alert>
      )}
    </Stack>
  );
}
