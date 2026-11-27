import {
  listClientPasskeysRoute,
  registerClientPasskeyRoute,
  registerOptionsClientPasskeyRoute,
  removeClientPasskeyRoute,
} from '@rumo/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { createPasskey, webAuthnAvailable } from '../../auth/webauthn.js';
import { usePage } from '../../pages/index.js';

export interface PasskeysData {
  readonly passkeys: readonly {
    readonly id: string;
    readonly name: string;
    readonly createdAt: string;
    readonly lastUsedAt: string | null;
  }[];
  readonly loaded: boolean;
  readonly available: boolean;
  add(name: string): Promise<unknown>;
  remove(id: string): Promise<unknown>;
}

export function usePasskeys(): PasskeysData | null {
  const page = usePage();
  const queryClient = useQueryClient();
  const key = [...(page?.base ?? []), 'passkeys'];
  const list = useQuery({
    queryKey: key,
    enabled: page !== null,
    queryFn: async () =>
      page === null ? [] : (await page.call(listClientPasskeysRoute, {})).passkeys,
  });
  const settled = (): Promise<void> => queryClient.invalidateQueries({ queryKey: key });
  const add = useMutation({
    mutationFn: async (name: string) => {
      const current = page as NonNullable<typeof page>;
      const { options, flow } = await current.call(registerOptionsClientPasskeyRoute, {});
      const response = await createPasskey(options);
      return current.call(registerClientPasskeyRoute, { flow, response, name });
    },
    onSettled: settled,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      (page as NonNullable<typeof page>).call(removeClientPasskeyRoute, { id }),
    onSettled: settled,
  });
  if (page === null) return null;
  return {
    passkeys: list.data ?? [],
    loaded: list.data !== undefined,
    available: webAuthnAvailable(),
    add: (name) => add.mutateAsync(name),
    remove: (id) => remove.mutateAsync(id),
  };
}
