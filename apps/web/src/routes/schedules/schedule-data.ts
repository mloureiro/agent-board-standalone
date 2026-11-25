import {
  listClientSchedulesRoute,
  removeClientScheduleRoute,
  setPausedClientScheduleRoute,
  updateClientScheduleRoute,
} from '@agent-board/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { usePage } from '../../pages/index.js';
import {
  decryptSchedule,
  updateRequest,
  type ScheduleEdit,
  type ScheduleView,
} from './schedule-model.js';

export const SCHEDULES_POLL_MS = 5_000;

export interface SchedulesData {
  readonly schedules: readonly ScheduleView[] | undefined;
  readonly failed: boolean;
  readonly offered: boolean;
  setPaused(id: string, paused: boolean): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  update(view: ScheduleView, edit: ScheduleEdit): Promise<unknown>;
}

export function useSchedules(project: string | null): SchedulesData | null {
  const page = usePage();
  const queryClient = useQueryClient();
  const offered = page?.features.includes('schedules') === true;
  const key = [...(page?.base ?? []), 'schedules'];

  const list = useQuery({
    queryKey: [...key, project ?? 'all'],
    enabled: page !== null && offered,
    refetchInterval: SCHEDULES_POLL_MS,
    queryFn: async (): Promise<ScheduleView[]> => {
      if (page === null) return [];
      const answer = await page.call(listClientSchedulesRoute, project === null ? {} : { project });
      return Promise.all(answer.schedules.map((wire) => decryptSchedule(page.keys, wire)));
    },
  });

  const settled = (): Promise<void> => queryClient.invalidateQueries({ queryKey: key });
  const setPaused = useMutation({
    mutationFn: (input: { id: string; paused: boolean }) =>
      (page as NonNullable<typeof page>).call(setPausedClientScheduleRoute, input),
    onSettled: settled,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      (page as NonNullable<typeof page>).call(removeClientScheduleRoute, { id }),
    onSettled: settled,
  });
  const update = useMutation({
    mutationFn: async (input: { view: ScheduleView; edit: ScheduleEdit }) => {
      const current = page as NonNullable<typeof page>;
      return current.call(
        updateClientScheduleRoute,
        await updateRequest(current.keys, input.view, input.edit),
      );
    },
    onSettled: settled,
  });

  if (page === null) return null;
  return {
    schedules: list.data,
    failed: list.isError,
    offered,
    setPaused: (id, paused) => setPaused.mutateAsync({ id, paused }),
    remove: (id) => remove.mutateAsync(id),
    update: (view, edit) => update.mutateAsync({ view, edit }),
  };
}
