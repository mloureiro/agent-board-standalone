import { useCallback, useMemo, useState } from 'react';

import { useKeys } from '../keys/index.js';
import { useServers } from '../servers/index.js';
import {
  draftStore,
  lastDirectoryStore,
  type DraftScope,
  type DraftStore,
  type LastDirectoryStore,
} from '../storage/index.js';

export function useDraftScope(): DraftScope | null {
  const { active } = useServers();
  const { state } = useKeys();
  const serverId = active?.id ?? null;
  const owner = state.status === 'unlocked' ? state.keys.owner : null;
  const keyId = state.status === 'unlocked' ? state.keys.keyId : null;
  return useMemo(
    () =>
      serverId === null || owner === null || keyId === null ? null : { serverId, owner, keyId },
    [serverId, owner, keyId],
  );
}

export function useDraftStore(): DraftStore | null {
  const scope = useDraftScope();
  return useMemo(() => (scope === null ? null : draftStore(scope)), [scope]);
}

export function useLastDirectoryStore(): LastDirectoryStore | null {
  const scope = useDraftScope();
  return useMemo(() => (scope === null ? null : lastDirectoryStore(scope)), [scope]);
}

export function useDraft(name: string, base?: string): readonly [string, (value: string) => void] {
  const store = useDraftStore();
  const [current, setCurrent] = useState(() => ({
    name,
    value: store?.read(name, base) ?? '',
  }));
  let value = current.value;
  if (current.name !== name) {
    value = store?.read(name, base) ?? '';
    setCurrent({ name, value });
  }
  const set = useCallback(
    (next: string) => {
      setCurrent({ name, value: next });
      if (next === '') store?.clear(name);
      else store?.write(name, next, base);
    },
    [store, name, base],
  );
  return [value, set];
}
