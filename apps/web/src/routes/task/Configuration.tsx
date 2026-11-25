import {
  EFFORTS,
  MODEL_ALIASES,
  PRIORITIES,
  type Effort,
  type Priority,
} from '@agent-board/contract';
import {
  Box,
  Button,
  Group,
  Modal,
  NativeSelect,
  Paper,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useState, type ReactNode } from 'react';

import type { ProjectOption, DirectoryOption, TaskActions } from './task-data.js';
import type { TaskView } from './task-model.js';

const DEFAULT = '';
const NO_DIRECTORY = '';

const titled = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

function LaneField(props: {
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onCommit: (lane: string | null) => void;
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? props.value ?? '';
  const commit = (): void => {
    if (draft === null) return;
    const lane = draft.trim() === '' ? null : draft.trim();
    setDraft(null);
    if (lane !== props.value) props.onCommit(lane);
  };
  return (
    <TextInput
      label="Lane"
      value={shown}
      disabled={props.disabled}
      description={props.disabled ? 'Locked while the task is running' : undefined}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
    />
  );
}

export function Configuration(props: {
  readonly view: TaskView;
  readonly actions: TaskActions;
  readonly projects: readonly ProjectOption[];
}): ReactNode {
  const { view, actions, projects } = props;
  const { task } = view;
  const models: { value: string; label: string }[] = [
    { value: DEFAULT, label: 'Default' },
    ...MODEL_ALIASES.map((model) => ({ value: model.value, label: model.label })),
  ];
  if (task.model !== null && !models.some((model) => model.value === task.model)) {
    models.push({ value: task.model, label: task.model });
  }
  const projectOptions =
    projects.length > 0 && !projects.some((project) => project.id === task.projectId)
      ? [{ id: task.projectId, name: 'Unknown project' }, ...projects]
      : projects;
  return (
    <Paper component="section" aria-label="Configuration" withBorder p="sm" radius="md">
      <Stack gap="sm">
        <Title order={2} size="h4">
          Configuration
        </Title>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
          <NativeSelect
            label="Priority"
            value={task.priority}
            data={PRIORITIES.map((priority) => ({ value: priority, label: titled(priority) }))}
            onChange={(event) => void actions.setPriority(event.currentTarget.value as Priority)}
          />
          <NativeSelect
            label="Model"
            value={task.model ?? DEFAULT}
            data={models}
            onChange={(event) =>
              void actions.configure({ model: event.currentTarget.value || null })
            }
          />
          <NativeSelect
            label="Effort"
            value={task.effort ?? DEFAULT}
            data={[
              { value: DEFAULT, label: 'Default' },
              ...EFFORTS.map((effort) => ({ value: effort, label: titled(effort) })),
            ]}
            onChange={(event) =>
              void actions.configure({
                effort: (event.currentTarget.value || null) as Effort | null,
              })
            }
          />
          <LaneField
            value={task.requestedLane}
            disabled={task.status === 'running'}
            onCommit={(lane) => void actions.configure({ lane })}
          />
          {projectOptions.length === 0 ? null : (
            <NativeSelect
              label="Project"
              value={task.projectId}
              data={projectOptions.map((project) => ({ value: project.id, label: project.name }))}
              onChange={(event) => void actions.setProject(event.currentTarget.value)}
            />
          )}
          <Box pt={{ base: 0, sm: 'xl' }}>
            <Switch
              label="Auto-done"
              checked={task.autoDone}
              onChange={(event) =>
                void actions.configure({ autoDone: event.currentTarget.checked })
              }
            />
          </Box>
        </SimpleGrid>
      </Stack>
    </Paper>
  );
}

export function DirectorySection(props: {
  readonly view: TaskView;
  readonly directories: readonly DirectoryOption[];
  readonly actions: TaskActions;
}): ReactNode {
  const { view, directories, actions } = props;
  const { task } = view;
  const [pending, setPending] = useState<{ directoryId: string | null } | null>(null);
  const current =
    task.directoryId === null
      ? null
      : (directories.find((directory) => directory.id === task.directoryId)?.path ?? null);
  const shown = current ?? view.legacyDirectory;
  const machine = task.machine;

  const apply = (directoryId: string | null): void => {
    void actions.configure({
      place: directoryId === null || machine === null ? null : { machine, directoryId },
    });
  };
  const choose = (directoryId: string | null): void => {
    if (directoryId === task.directoryId) return;
    if (task.sessionId !== null) setPending({ directoryId });
    else apply(directoryId);
  };

  return (
    <Paper component="section" aria-label="Directory" withBorder p="sm" radius="md">
      <Stack gap="xs">
        <Title order={2} size="h4">
          Directory
        </Title>
        <Text size="sm" ff="monospace">
          {shown ?? 'No directory'}
        </Text>
        {directories.length === 0 && task.directoryId === null ? null : (
          <Group align="flex-end" gap="xs">
            <NativeSelect
              label="Working directory"
              value={task.directoryId ?? NO_DIRECTORY}
              data={[
                { value: NO_DIRECTORY, label: 'No directory' },
                ...directories.map((directory) => ({
                  value: directory.id,
                  label: directory.path,
                  disabled: machine === null,
                })),
              ]}
              onChange={(event) => choose(event.currentTarget.value || null)}
              style={{ flex: 1 }}
            />
            {task.directoryId === null ? null : (
              <Button variant="default" onClick={() => choose(null)}>
                Clear directory
              </Button>
            )}
          </Group>
        )}
      </Stack>
      <Modal
        opened={pending !== null}
        onClose={() => setPending(null)}
        title="Change the working directory"
      >
        <Stack>
          <Text size="sm">This task has a session. Changing the directory drops that session.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              color="red"
              onClick={() => {
                if (pending !== null) apply(pending.directoryId);
                setPending(null);
              }}
            >
              Change directory
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  );
}
