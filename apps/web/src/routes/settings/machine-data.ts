import {
  issueClientMachineRoute,
  listClientMachinesRoute,
  revokeClientMachineRoute,
  setGrantClientMachineRoute,
} from '@agent-board/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { usePage } from '../../pages/index.js';
import { decryptMachine, type MachineView } from './machine-model.js';

export const MACHINES_POLL_MS = 15_000;

export interface MachinesData {
  readonly machines: readonly MachineView[] | undefined;
  readonly failed: boolean;
  readonly grants: boolean;
  issue(name: string): Promise<string>;
  revoke(name: string): Promise<unknown>;
  setGrant(name: string, grant: boolean): Promise<unknown>;
}

export function useMachines(): MachinesData | null {
  const page = usePage();
  const queryClient = useQueryClient();
  const key = [...(page?.base ?? []), 'settings-machines'];

  const list = useQuery({
    queryKey: key,
    enabled: page !== null,
    refetchInterval: MACHINES_POLL_MS,
    queryFn: async (): Promise<MachineView[]> => {
      if (page === null) return [];
      const answer = await page.call(listClientMachinesRoute, {});
      const active = answer.machines.filter((machine) => machine.revokedAt === null);
      return Promise.all(active.map((machine) => decryptMachine(page.keys, machine)));
    },
  });
  const settled = (): Promise<void> => queryClient.invalidateQueries({ queryKey: key });
  const issue = useMutation({
    mutationFn: async (name: string) =>
      (await (page as NonNullable<typeof page>).call(issueClientMachineRoute, { name })).token,
    onSettled: settled,
    gcTime: 0,
  });
  const revoke = useMutation({
    mutationFn: (name: string) =>
      (page as NonNullable<typeof page>).call(revokeClientMachineRoute, { name }),
    onSettled: settled,
  });
  const grant = useMutation({
    mutationFn: (input: { name: string; grant: boolean }) =>
      (page as NonNullable<typeof page>).call(setGrantClientMachineRoute, input),
    onSettled: settled,
  });

  if (page === null) return null;
  return {
    machines: list.data,
    failed: list.isError,
    grants: page.features.includes('machine-grant'),
    issue: (name) => issue.mutateAsync(name).finally(() => issue.reset()),
    revoke: (name) => revoke.mutateAsync(name),
    setGrant: (name, value) => grant.mutateAsync({ name, grant: value }),
  };
}
