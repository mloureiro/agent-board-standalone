import {
  Anchor,
  Badge,
  Box,
  Breadcrumbs,
  Button,
  Group,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { COLUMN_LABELS } from '../board/columns.js';
import type { TaskActions } from './task-data.js';
import type { TaskView } from './task-model.js';

const CREATOR_LABELS = { user: 'you', agent: 'an agent', intake: 'intake' } as const;

function RenameForm(props: {
  readonly title: string;
  readonly onSave: (title: string) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const [value, setValue] = useState(props.title);
  const trimmed = value.trim();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed !== '') props.onSave(trimmed);
      }}
    >
      <Group align="flex-end" gap="xs">
        <TextInput
          label="Title"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          data-autofocus
          style={{ flex: 1 }}
        />
        <Button type="submit" disabled={trimmed === ''}>
          Save title
        </Button>
        <Button type="button" variant="default" onClick={props.onCancel}>
          Cancel
        </Button>
      </Group>
    </form>
  );
}

export function TaskHeader(props: {
  readonly view: TaskView;
  readonly projectName: string | null;
  readonly actions: TaskActions;
  readonly extra?: ReactNode;
}): ReactNode {
  const { view, projectName, actions } = props;
  const { task } = view;
  const [renaming, setRenaming] = useState(false);
  return (
    <Stack gap="xs">
      <Box component="nav" aria-label="Breadcrumb">
        <Breadcrumbs>
          <Anchor component={Link} to="/" size="sm">
            Board
          </Anchor>
          {projectName === null ? null : (
            <Text size="sm" span>
              {projectName}
            </Text>
          )}
          <Text size="sm" span aria-current="page">
            {view.title}
          </Text>
        </Breadcrumbs>
      </Box>
      {renaming ? (
        <RenameForm
          title={view.title}
          onSave={(title) => {
            void actions.rename(title);
            setRenaming(false);
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <Group gap="sm" wrap="wrap">
          {view.icon === null ? null : (
            <Text span aria-hidden size="xl">
              {view.icon}
            </Text>
          )}
          <Title order={1} size="h2">
            {view.title}
          </Title>
          <Badge role="status" aria-label="Task status" variant="light">
            {COLUMN_LABELS[task.status]}
          </Badge>
          <Text size="sm" c="dimmed">
            Created by {CREATOR_LABELS[task.createdBy]}
          </Text>
          <Button size="xs" variant="default" onClick={() => setRenaming(true)}>
            Rename
          </Button>
          {props.extra}
        </Group>
      )}
      {view.labels.length === 0 ? null : (
        <Group gap={4} aria-label="Labels" role="list">
          {view.labels.map((label) => (
            <Badge key={label} role="listitem" variant="outline" size="sm">
              {label}
            </Badge>
          ))}
        </Group>
      )}
      {view.parent === null ? null : (
        <Text size="sm">
          Follow-up of{' '}
          <Anchor component={Link} to={`/tasks/${view.parent.id}`}>
            {view.parent.title}
          </Anchor>
        </Text>
      )}
      {view.followUps.length === 0 ? null : (
        <Text size="sm">
          Follow-ups:{' '}
          {view.followUps.map((followUp, index) => (
            <span key={followUp.id}>
              {index === 0 ? '' : ', '}
              <Anchor component={Link} to={`/tasks/${followUp.id}`}>
                {followUp.title}
              </Anchor>
            </span>
          ))}
        </Text>
      )}
    </Stack>
  );
}
