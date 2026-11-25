import { Alert, Badge, Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { useState, type ReactNode } from 'react';

import { usePageTitle } from '../../components/index.js';
import { useProjectFilter } from '../../projects/project-filter.js';
import { notOffered } from '../../servers/index.js';
import { useNow } from '../board/clock.js';
import { inText, parseTime } from '../board/format.js';
import { DeleteScheduleDialog } from './DeleteScheduleDialog.js';
import { ScheduleEditDialog } from './ScheduleEditDialog.js';
import { useSchedules } from './schedule-data.js';
import { repeatText, type ScheduleView } from './schedule-model.js';

export const NO_SCHEDULES = 'There are no schedules.';
export const SCHEDULES_UNAVAILABLE = notOffered('schedules');

function ScheduleRow(props: {
  readonly view: ScheduleView;
  readonly now: number;
  readonly onPause: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}): ReactNode {
  const { view, now } = props;
  const { wire } = view;
  const next = parseTime(wire.nextRunAt);
  return (
    <Paper component="li" withBorder p="sm" style={{ listStyle: 'none' }}>
      <Group justify="space-between" wrap="wrap">
        <Stack gap={2}>
          <Group gap="xs">
            <Text fw={500}>{view.title}</Text>
            {wire.paused ? <Badge color="yellow">Paused</Badge> : null}
            {wire.ended ? <Badge color="gray">Ended</Badge> : null}
          </Group>
          <Text size="sm" c="dimmed">
            {repeatText(wire)}
            {next === null || wire.paused ? '' : `, next run ${inText(next, now) ?? 'due'}`}
          </Text>
        </Stack>
        <Group gap="xs">
          <Button variant="default" onClick={props.onPause}>
            {wire.paused ? 'Resume' : 'Pause'}
          </Button>
          <Button variant="default" onClick={props.onEdit}>
            Edit
          </Button>
          <Button variant="default" color="red" onClick={props.onDelete}>
            Delete
          </Button>
        </Group>
      </Group>
    </Paper>
  );
}

export function SchedulesPage(): ReactNode {
  usePageTitle('Schedules');
  const [editing, setEditing] = useState<ScheduleView | null>(null);
  const [deleting, setDeleting] = useState<ScheduleView | null>(null);
  const { projectId } = useProjectFilter();
  const data = useSchedules(projectId);
  const now = useNow();

  return (
    <Stack>
      <Title order={1}>Schedules</Title>
      {data !== null && !data.offered ? <Text c="dimmed">{SCHEDULES_UNAVAILABLE}</Text> : null}
      {data?.failed === true ? (
        <Alert color="red" role="alert">
          The schedules could not be loaded.
        </Alert>
      ) : null}
      {data?.schedules?.length === 0 ? <Text c="dimmed">{NO_SCHEDULES}</Text> : null}
      <Stack component="ul" gap="xs" p={0} m={0} aria-label="Schedules">
        {(data?.schedules ?? []).map((view) => (
          <ScheduleRow
            key={view.wire.id}
            view={view}
            now={now}
            onPause={() => void data?.setPaused(view.wire.id, !view.wire.paused)}
            onEdit={() => setEditing(view)}
            onDelete={() => setDeleting(view)}
          />
        ))}
      </Stack>
      {data === null ? null : (
        <>
          <ScheduleEditDialog
            view={editing}
            onClose={() => setEditing(null)}
            onSave={(view, edit) => data.update(view, edit)}
          />
          <DeleteScheduleDialog
            view={deleting}
            onClose={() => setDeleting(null)}
            onDelete={(view) => data.remove(view.wire.id)}
          />
        </>
      )}
    </Stack>
  );
}
