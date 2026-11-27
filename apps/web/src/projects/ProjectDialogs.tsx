import { Button, Group, Modal, Radio, Stack, Text, TextInput } from '@mantine/core';
import type { ProjectDeleteThen } from '@rumo/contract';
import { useState, type ReactNode } from 'react';

import type { ProjectEntry } from './fetch-projects.js';

export type ProjectDialog =
  | { readonly kind: 'create' }
  | { readonly kind: 'rename'; readonly project: ProjectEntry }
  | { readonly kind: 'icon'; readonly project: ProjectEntry }
  | { readonly kind: 'delete'; readonly project: ProjectEntry; readonly hasTasks: boolean };

export interface ProjectDialogActions {
  create(name: string, icon: string | null): Promise<void>;
  rename(project: ProjectEntry, name: string): Promise<void>;
  setIcon(project: ProjectEntry, icon: string | null): Promise<void>;
  remove(project: ProjectEntry, then: ProjectDeleteThen | undefined): Promise<void>;
}

function NameForm(props: {
  readonly initial: string;
  readonly submit: string;
  readonly withIcon: boolean;
  readonly onSubmit: (name: string, icon: string | null) => Promise<void>;
}): ReactNode {
  const [name, setName] = useState(props.initial);
  const [icon, setIcon] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = name.trim() !== '' && !busy;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        setBusy(true);
        void props
          .onSubmit(name.trim(), icon.trim() === '' ? null : icon.trim())
          .catch(() => undefined)
          .finally(() => setBusy(false));
      }}
    >
      <Stack>
        <TextInput
          label="Name"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          data-autofocus
        />
        {props.withIcon ? (
          <TextInput
            label="Icon"
            value={icon}
            onChange={(event) => setIcon(event.currentTarget.value)}
          />
        ) : null}
        <Group justify="flex-end">
          <Button type="submit" disabled={!ready}>
            {props.submit}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function IconForm(props: {
  readonly initial: string;
  readonly onSubmit: (icon: string | null) => Promise<void>;
}): ReactNode {
  const [icon, setIcon] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        void props
          .onSubmit(icon.trim() === '' ? null : icon.trim())
          .catch(() => undefined)
          .finally(() => setBusy(false));
      }}
    >
      <Stack>
        <TextInput
          label="Icon"
          description="Leave empty to remove the icon"
          value={icon}
          onChange={(event) => setIcon(event.currentTarget.value)}
          data-autofocus
        />
        <Group justify="flex-end">
          <Button type="submit" disabled={busy}>
            Save
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function DeleteForm(props: {
  readonly project: ProjectEntry;
  readonly hasTasks: boolean;
  readonly onSubmit: (then: ProjectDeleteThen | undefined) => Promise<void>;
}): ReactNode {
  const [then, setThen] = useState<ProjectDeleteThen>('move-to-default');
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        void props
          .onSubmit(props.hasTasks ? then : undefined)
          .catch(() => undefined)
          .finally(() => setBusy(false));
      }}
    >
      <Stack>
        <Text>
          {props.hasTasks
            ? `${props.project.label} still has tasks, schedules or directories. Choose what happens to them.`
            : `Delete ${props.project.label}? This cannot be undone.`}
        </Text>
        {props.hasTasks ? (
          <Radio.Group value={then} onChange={(value) => setThen(value as ProjectDeleteThen)}>
            <Stack gap="xs">
              <Radio
                value="move-to-default"
                label="Move its tasks, schedules and directories to the default project"
              />
              <Radio
                value="delete"
                label="Delete its tasks, schedules and directories with the project"
              />
            </Stack>
          </Radio.Group>
        ) : null}
        <Group justify="flex-end">
          <Button type="submit" color="red" disabled={busy}>
            Delete project
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

const TITLES = {
  create: 'New project',
  rename: 'Rename project',
  icon: 'Change icon',
  delete: 'Delete project',
} as const;

export function ProjectDialogs(props: {
  readonly dialog: ProjectDialog | null;
  readonly actions: ProjectDialogActions;
  readonly onClose: () => void;
}): ReactNode {
  const { dialog, actions, onClose } = props;
  const finish = async (run: Promise<void>): Promise<void> => {
    await run;
    onClose();
  };
  return (
    <Modal
      opened={dialog !== null}
      onClose={onClose}
      title={dialog === null ? '' : TITLES[dialog.kind]}
      centered
    >
      {dialog?.kind === 'create' ? (
        <NameForm
          initial=""
          submit="Create project"
          withIcon
          onSubmit={(name, icon) => finish(actions.create(name, icon))}
        />
      ) : null}
      {dialog?.kind === 'rename' ? (
        <NameForm
          initial={dialog.project.name ?? ''}
          submit="Save"
          withIcon={false}
          onSubmit={(name) => finish(actions.rename(dialog.project, name))}
        />
      ) : null}
      {dialog?.kind === 'icon' ? (
        <IconForm
          initial={dialog.project.icon ?? ''}
          onSubmit={(icon) => finish(actions.setIcon(dialog.project, icon))}
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <DeleteForm
          project={dialog.project}
          hasTasks={dialog.hasTasks}
          onSubmit={(then) => finish(actions.remove(dialog.project, then))}
        />
      ) : null}
    </Modal>
  );
}
