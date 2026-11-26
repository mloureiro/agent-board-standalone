import { useEffect, useState } from 'react';

export type Permission = 'granted' | 'denied' | 'default' | 'unsupported';

const permissionOf = (): Permission =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

const FROM_QUERY: Readonly<Record<string, Permission>> = {
  granted: 'granted',
  denied: 'denied',
  prompt: 'default',
};

export function useNotificationPermission(): readonly [Permission, (next: Permission) => void] {
  const [permission, setPermission] = useState<Permission>(permissionOf);
  useEffect(() => {
    if (typeof Notification === 'undefined' || navigator.permissions === undefined) {
      return undefined;
    }
    let cancelled = false;
    let status: PermissionStatus | null = null;
    const read = (): void => {
      const mapped = status === null ? undefined : FROM_QUERY[status.state];
      if (!cancelled && mapped !== undefined) setPermission(mapped);
    };
    navigator.permissions
      .query({ name: 'notifications' })
      .then((answer) => {
        status = answer;
        answer.addEventListener('change', read);
        read();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      status?.removeEventListener('change', read);
    };
  }, []);
  return [permission, setPermission];
}
