import type { ScheduleDraft, UiTaskCreate } from '@rumo/contract';

type Repeating = Exclude<NonNullable<UiTaskCreate['when']>, string | { at: string }>;

export const isRepeating = (when: UiTaskCreate['when']): when is Repeating =>
  typeof when === 'object' && ('every' in when || 'cron' in when || 'after' in when);

const ruleOf = (when: Repeating): Partial<ScheduleDraft> => {
  if ('every' in when) return { everyMs: when.every };
  if ('after' in when) return { after: when.after };
  return {
    cron: when.cron,
    timezone: when.timezone,
    ...(when.moreCrons === undefined ? {} : { moreCrons: when.moreCrons }),
  };
};

export const draftOfRepeating = (create: UiTaskCreate, when: Repeating): ScheduleDraft => {
  const { id, title, input, priority, model, effort, lane, autoDone, projectId } = create;
  const { agent, icon, labels, place } = create;
  const startAt = 'at' in when ? when.at : undefined;
  return {
    id,
    title,
    input,
    ...(priority === undefined ? {} : { priority }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(lane === undefined ? {} : { lane }),
    ...(autoDone === undefined ? {} : { autoDone }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(agent === undefined ? {} : { agent }),
    ...(icon === undefined ? {} : { icon }),
    ...(labels === undefined ? {} : { labels }),
    ...(place === undefined ? {} : { machine: place.machine, directoryId: place.directoryId }),
    ...ruleOf(when),
    ...(startAt === undefined ? {} : { startAt }),
    ...(when.times === undefined ? {} : { times: when.times }),
    ...(when.until === undefined ? {} : { until: when.until }),
    ...(when.maxConcurrent === undefined ? {} : { maxConcurrent: when.maxConcurrent }),
  };
};
