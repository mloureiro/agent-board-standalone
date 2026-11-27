import { PRIORITIES, type Priority } from '@rumo/contract';
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useState, type FormEvent, type ReactNode } from 'react';

import { useDraft } from '../../drafts/index.js';
import type { ScheduleEdit, ScheduleView } from './schedule-model.js';

const titled = (text: string): string => `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;
const MS_PER_MINUTE = 60_000;

function EditForm(props: {
  readonly view: ScheduleView;
  readonly onClose: () => void;
  readonly onSave: (view: ScheduleView, edit: ScheduleEdit) => Promise<unknown>;
}): ReactNode {
  const { view, onClose, onSave } = props;
  const { wire } = view;
  const prompt = view.prompt ?? '';
  const [titleDraft, setTitleDraft] = useDraft(`schedule:${wire.id}:title`, view.title);
  const [promptDraft, setPromptDraft] = useDraft(`schedule:${wire.id}:prompt`, prompt);
  const [title, setTitle] = useState(titleDraft === '' ? view.title : titleDraft);
  const [text, setText] = useState(promptDraft === '' ? prompt : promptDraft);
  const [priority, setPriority] = useState<Priority>(wire.priority);
  const [autoDone, setAutoDone] = useState(wire.autoDone);
  const [minutes, setMinutes] = useState<number | null>(
    wire.everyMs === null ? null : Math.max(1, Math.round(wire.everyMs / MS_PER_MINUTE)),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const changeTitle = (next: string): void => {
    setTitle(next);
    setTitleDraft(next === view.title ? '' : next);
  };
  const changePrompt = (next: string): void => {
    setText(next);
    setPromptDraft(next === prompt ? '' : next);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (title.trim() === '' || text.trim() === '') {
      setError('The title and the prompt cannot be empty.');
      return;
    }
    setBusy(true);
    setError(null);
    onSave(view, { title: title.trim(), prompt: text, priority, autoDone, everyMinutes: minutes })
      .then(() => {
        setTitleDraft('');
        setPromptDraft('');
        onClose();
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'The schedule could not be saved.'),
      )
      .finally(() => setBusy(false));
  };

  return (
    <form onSubmit={submit}>
      <Stack>
        <TextInput
          label="Title"
          value={title}
          onChange={(event) => changeTitle(event.currentTarget.value)}
          data-autofocus
        />
        <Textarea
          label="Prompt"
          autosize
          minRows={4}
          value={text}
          onChange={(event) => changePrompt(event.currentTarget.value)}
        />
        <Select
          label="Priority"
          allowDeselect={false}
          value={priority}
          data={PRIORITIES.map((entry) => ({ value: entry, label: titled(entry) }))}
          onChange={(value) => setPriority((value ?? 'normal') as Priority)}
        />
        {minutes === null ? null : (
          <NumberInput
            label="Repeat every (minutes)"
            min={1}
            allowDecimal={false}
            value={minutes}
            onChange={(value) => setMinutes(typeof value === 'number' ? value : null)}
          />
        )}
        <Checkbox
          label="Auto-done"
          checked={autoDone}
          onChange={(event) => setAutoDone(event.currentTarget.checked)}
        />
        {error === null ? null : (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Save
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

export function ScheduleEditDialog(props: {
  readonly view: ScheduleView | null;
  readonly onClose: () => void;
  readonly onSave: (view: ScheduleView, edit: ScheduleEdit) => Promise<unknown>;
}): ReactNode {
  const { view, onClose, onSave } = props;
  return (
    <Modal opened={view !== null} onClose={onClose} title="Edit schedule" centered size="lg">
      {view === null ? null : (
        <EditForm key={view.wire.id} view={view} onClose={onClose} onSave={onSave} />
      )}
    </Modal>
  );
}
