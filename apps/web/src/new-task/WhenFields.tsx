import { NativeSelect, SimpleGrid, Stack, Textarea, TextInput } from '@mantine/core';
import type { ReactNode } from 'react';

import type { Option } from './new-task-data.js';
import {
  INTERVAL_UNITS,
  REPEAT_KINDS,
  WHEN_KINDS,
  WHEN_LABELS,
  type FormProblems,
  type IntervalUnit,
  type NewTaskForm,
  type RepeatKind,
  type WhenKind,
} from './new-task-model.js';

const REPEAT_LABELS: Record<RepeatKind, string> = {
  interval: 'Every interval',
  crons: 'Cron schedule',
  after: 'After another schedule',
};

export function WhenFields(props: {
  readonly form: NewTaskForm;
  readonly problems: FormProblems;
  readonly schedules: readonly Option[];
  readonly onChange: (change: Partial<NewTaskForm>) => void;
}): ReactNode {
  const { form, problems, schedules, onChange } = props;
  const repeating = form.when === 'repeating';
  const kinds = REPEAT_KINDS.filter((kind) => kind !== 'after' || schedules.length > 0);
  return (
    <Stack gap="xs">
      <NativeSelect
        label="When"
        value={form.when}
        data={WHEN_KINDS.map((kind) => ({ value: kind, label: WHEN_LABELS[kind] }))}
        onChange={(event) => onChange({ when: event.currentTarget.value as WhenKind })}
      />
      {form.when === 'later' || repeating ? (
        <TextInput
          label={repeating ? 'First run (optional)' : 'Start at'}
          type="datetime-local"
          value={form.startAt}
          error={problems.startAt}
          onChange={(event) => onChange({ startAt: event.currentTarget.value })}
        />
      ) : null}
      {repeating ? (
        <>
          <NativeSelect
            label="Repeat"
            value={form.repeat}
            data={kinds.map((kind) => ({ value: kind, label: REPEAT_LABELS[kind] }))}
            onChange={(event) => onChange({ repeat: event.currentTarget.value as RepeatKind })}
          />
          {form.repeat === 'interval' ? (
            <SimpleGrid cols={2}>
              <TextInput
                label="Every"
                inputMode="numeric"
                value={form.every}
                error={problems.every}
                onChange={(event) => onChange({ every: event.currentTarget.value })}
              />
              <NativeSelect
                label="Unit"
                value={form.everyUnit}
                data={Object.keys(INTERVAL_UNITS)}
                onChange={(event) =>
                  onChange({ everyUnit: event.currentTarget.value as IntervalUnit })
                }
              />
            </SimpleGrid>
          ) : null}
          {form.repeat === 'crons' ? (
            <>
              <Textarea
                label="Crons"
                description="One cron expression per line"
                autosize
                minRows={2}
                value={form.crons}
                error={problems.crons}
                onChange={(event) => onChange({ crons: event.currentTarget.value })}
              />
              <TextInput
                label="Timezone"
                value={form.timezone}
                error={problems.timezone}
                onChange={(event) => onChange({ timezone: event.currentTarget.value })}
              />
            </>
          ) : null}
          {form.repeat === 'after' ? (
            <SimpleGrid cols={2}>
              <NativeSelect
                label="Run after"
                value={form.afterId}
                error={problems.afterId}
                data={[
                  { value: '', label: 'Pick a schedule' },
                  ...schedules.map((schedule) => ({ value: schedule.id, label: schedule.label })),
                ]}
                onChange={(event) => onChange({ afterId: event.currentTarget.value })}
              />
              <TextInput
                label="Delay (minutes)"
                inputMode="numeric"
                value={form.afterDelay}
                error={problems.afterDelay}
                onChange={(event) => onChange({ afterDelay: event.currentTarget.value })}
              />
            </SimpleGrid>
          ) : null}
          <SimpleGrid cols={2}>
            <TextInput
              label="Runs"
              description="Stop after this many runs"
              inputMode="numeric"
              value={form.runs}
              error={problems.runs}
              onChange={(event) => onChange({ runs: event.currentTarget.value })}
            />
            <TextInput
              label="At most"
              description="Runs at the same time"
              inputMode="numeric"
              value={form.atMost}
              error={problems.atMost}
              onChange={(event) => onChange({ atMost: event.currentTarget.value })}
            />
          </SimpleGrid>
        </>
      ) : null}
    </Stack>
  );
}
