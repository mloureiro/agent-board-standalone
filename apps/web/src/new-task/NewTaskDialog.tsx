import { EFFORTS, MODEL_ALIASES, PRIORITIES } from '@rumo/contract';
import {
  Button,
  Checkbox,
  Group,
  Modal,
  NativeSelect,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import { dialogPortal } from '../components/PageStart.js';
import { useDraft, useLastDirectoryStore } from '../drafts/index.js';
import { useRecentIcons } from '../pages/index.js';
import { useProjectFilter } from '../projects/project-filter.js';
import { newTaskId } from '../routes/task/compose.js';
import { IconPicker } from './IconPicker.js';
import { useNewTaskOptions, type NewTaskOptions, type ProjectOption } from './new-task-data.js';
import {
  buildCreate,
  formProblems,
  isBlankForm,
  resolvePlace,
  restoreForm,
  type NewTaskForm,
} from './new-task-model.js';
import { WhenFields } from './WhenFields.js';

const DRAFT_NAME = 'new';
const PHONE_QUERY = '(max-width: 48em)';

function chosenProject(
  projects: readonly ProjectOption[],
  picked: string,
  filtered: string | null,
): string {
  const known = (id: string | null): id is string =>
    id !== null && id !== '' && projects.some((project) => project.id === id);
  if (known(picked)) return picked;
  if (known(filtered)) return filtered;
  return projects.find((project) => project.isDefault)?.id ?? '';
}

const sentProject = (projects: readonly ProjectOption[], projectId: string): string =>
  projects.find((project) => project.isDefault)?.id === projectId ? '' : projectId;

const titled = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

function Fields(props: {
  readonly options: NewTaskOptions;
  readonly onCreated: () => void;
}): ReactNode {
  const { options, onCreated } = props;
  const [raw, setRaw] = useDraft(DRAFT_NAME);
  const lastDirectory = useLastDirectoryStore();
  const recentIcons = useRecentIcons();
  const [submitting, setSubmitting] = useState(false);
  const form = useMemo(() => restoreForm(raw), [raw]);
  const remembered = useMemo(() => lastDirectory?.read() ?? null, [lastDirectory]);
  const { projectId: filtered } = useProjectFilter();
  const listsKnown = options.directories !== undefined && options.machines !== undefined;
  const projectId = chosenProject(options.projects, form.projectId, filtered);
  const directories = (options.directories ?? []).filter(
    (directory) => projectId === '' || directory.projectId === projectId,
  );
  const place = resolvePlace({
    form,
    remembered,
    directories: directories.map((directory) => directory.id),
    machines: options.machines ?? [],
    directoriesKnown: listsKnown,
  });
  const staleRemembered = resolvePlace({
    form,
    remembered,
    directories: (options.directories ?? []).map((directory) => directory.id),
    machines: options.machines ?? [],
  }).staleRemembered;
  const problems = formProblems(form);
  const canCreate = form.prompt.trim() !== '' && Object.keys(problems).length === 0 && !submitting;

  useEffect(() => {
    if (listsKnown && staleRemembered) lastDirectory?.clear();
  }, [listsKnown, staleRemembered, lastDirectory]);

  const change = (next: Partial<NewTaskForm>): void => {
    const merged = { ...form, ...next };
    setRaw(isBlankForm(merged) ? '' : JSON.stringify(merged));
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canCreate) return;
    setSubmitting(true);
    try {
      const request = await buildCreate(
        options.keys,
        {
          ...form,
          projectId: sentProject(options.projects, projectId),
          directoryId: place.directoryId,
        },
        { id: newTaskId(), machine: place.machine },
      );
      await options.create(request);
      if (place.directoryId !== '' && place.machine !== null) {
        lastDirectory?.write({ machine: place.machine, directoryId: place.directoryId });
      }
      setRaw('');
      onCreated();
    } catch {
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
  };

  const machines = options.machines ?? [];
  const noMachine = options.directoriesEnabled && machines.length === 0 && listsKnown;

  return (
    <form onSubmit={(event) => void submit(event)}>
      <Stack>
        <Textarea
          label="Prompt"
          autosize
          minRows={4}
          maxRows={14}
          value={form.prompt}
          onChange={(event) => change({ prompt: event.currentTarget.value })}
          data-autofocus
        />
        <Group align="flex-end" wrap="nowrap">
          <TextInput
            label="Title"
            placeholder="First line of the prompt"
            value={form.title}
            onChange={(event) => change({ title: event.currentTarget.value })}
            style={{ flex: 1 }}
          />
          <IconPicker
            value={form.icon}
            recent={recentIcons.icons}
            onChange={(icon) => {
              change({ icon });
              recentIcons.record(icon);
            }}
          />
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          {options.projects.length > 0 ? (
            <NativeSelect
              label="Project"
              value={projectId}
              data={options.projects.map((project) => ({
                value: project.id,
                label: project.label,
              }))}
              onChange={(event) =>
                change({ projectId: event.currentTarget.value, directoryId: null })
              }
            />
          ) : null}
          {options.directoriesEnabled ? (
            <NativeSelect
              label="Directory"
              value={place.directoryId}
              disabled={noMachine}
              description={noMachine ? 'No machine is connected yet' : undefined}
              data={[
                { value: '', label: 'No directory' },
                ...directories.map((directory) => ({
                  value: directory.id,
                  label: directory.label,
                })),
              ]}
              onChange={(event) => change({ directoryId: event.currentTarget.value })}
            />
          ) : null}
          {options.directoriesEnabled && machines.length > 1 ? (
            <NativeSelect
              label="Machine"
              value={place.machine ?? ''}
              data={machines}
              onChange={(event) => change({ machine: event.currentTarget.value })}
            />
          ) : null}
          <TextInput
            label="Labels"
            description="Separate labels with commas"
            value={form.labels}
            onChange={(event) => change({ labels: event.currentTarget.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
          />
          <NativeSelect
            label="Priority"
            value={form.priority}
            data={PRIORITIES.map((priority) => ({ value: priority, label: titled(priority) }))}
            onChange={(event) =>
              change({ priority: event.currentTarget.value as NewTaskForm['priority'] })
            }
          />
          <NativeSelect
            label="Model"
            value={form.model}
            data={[
              { value: '', label: 'Default' },
              ...MODEL_ALIASES.map((model) => ({ value: model.value, label: model.label })),
            ]}
            onChange={(event) => change({ model: event.currentTarget.value })}
          />
          <NativeSelect
            label="Effort"
            value={form.effort}
            data={[
              { value: '', label: 'Default' },
              ...EFFORTS.map((effort) => ({ value: effort, label: titled(effort) })),
            ]}
            onChange={(event) =>
              change({ effort: event.currentTarget.value as NewTaskForm['effort'] })
            }
          />
          <TextInput
            label="Lane"
            value={form.lane}
            error={problems.lane}
            onChange={(event) => change({ lane: event.currentTarget.value })}
          />
          <TextInput
            label="Agent"
            value={form.agent}
            error={problems.agent}
            onChange={(event) => change({ agent: event.currentTarget.value })}
          />
        </SimpleGrid>
        <Checkbox
          label="Auto-done"
          checked={form.autoDone}
          onChange={(event) => change({ autoDone: event.currentTarget.checked })}
        />
        <WhenFields
          form={form}
          problems={problems}
          schedules={options.schedules}
          onChange={change}
        />
        <Group justify="space-between">
          <Text size="xs" c="dimmed">
            Unsent text is kept as a draft on this device.
          </Text>
          <Button type="submit" disabled={!canCreate} loading={submitting}>
            Create task
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function Body(props: { readonly onClose: () => void }): ReactNode {
  const options = useNewTaskOptions();
  return options === null ? null : <Fields options={options} onCreated={props.onClose} />;
}

export function NewTaskDialog(props: {
  readonly opened: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false }) ?? false;
  return (
    <Modal
      opened={props.opened}
      onClose={props.onClose}
      title="New task"
      centered={!phone}
      fullScreen={phone}
      size="lg"
      portalProps={dialogPortal()}
      onEnterTransitionEnd={() =>
        dialogPortal().target?.querySelector<HTMLElement>('[role="dialog"]')?.focus()
      }
      withOverlay={false}
      trapFocus={false}
      lockScroll={false}
      closeOnClickOutside={false}
      styles={{ inner: { pointerEvents: 'none' }, content: { pointerEvents: 'auto' } }}
    >
      <Body onClose={props.onClose} />
    </Modal>
  );
}
