import { Button, Group, Modal, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { useState, type ReactNode } from 'react';

import { Markdown } from '../../components/index.js';
import { useDraft } from '../../drafts/index.js';
import type { PolishRewrite } from './action-model.js';

interface PromptValue {
  readonly title: string;
  readonly text: string;
}

function PromptForm(props: {
  readonly draftKey: string;
  readonly initial: PromptValue;
  readonly titleLabel: string;
  readonly textLabel: string;
  readonly submitLabel: string;
  readonly textFirst?: boolean;
  readonly onSubmit: (value: PromptValue) => Promise<boolean>;
  readonly onDone: () => void;
}): ReactNode {
  const [titleDraft, setTitleDraft] = useDraft(`${props.draftKey}:title`, props.initial.title);
  const [textDraft, setTextDraft] = useDraft(`${props.draftKey}:text`, props.initial.text);
  const [title, setTitle] = useState(titleDraft === '' ? props.initial.title : titleDraft);
  const [text, setText] = useState(textDraft === '' ? props.initial.text : textDraft);
  const [busy, setBusy] = useState(false);
  const ready = title.trim() !== '' && text.trim() !== '';
  const changeTitle = (next: string): void => {
    setTitle(next);
    setTitleDraft(next === props.initial.title ? '' : next);
  };
  const changeText = (next: string): void => {
    setText(next);
    setTextDraft(next === props.initial.text ? '' : next);
  };
  const titleField = (
    <TextInput
      key="title"
      label={props.titleLabel}
      value={title}
      onChange={(event) => changeTitle(event.currentTarget.value)}
    />
  );
  const textField = (
    <Textarea
      key="text"
      label={props.textLabel}
      autosize
      minRows={5}
      maxRows={16}
      value={text}
      onChange={(event) => changeText(event.currentTarget.value)}
      data-autofocus={props.textFirst === true ? true : undefined}
    />
  );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || busy) return;
        setBusy(true);
        void props.onSubmit({ title: title.trim(), text }).then((ok) => {
          setBusy(false);
          if (!ok) return;
          setTitleDraft('');
          setTextDraft('');
          props.onDone();
        });
      }}
    >
      <Stack>
        {props.textFirst === true ? [textField, titleField] : [titleField, textField]}
        <Group justify="flex-end">
          <Button type="submit" disabled={!ready || busy}>
            {props.submitLabel}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

export function ForkDialog(props: {
  readonly taskId: string;
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly onFork: (value: PromptValue) => Promise<boolean>;
}): ReactNode {
  return (
    <Modal opened={props.opened} onClose={props.onClose} title="Fork" centered size="lg">
      <PromptForm
        draftKey={`fork:${props.taskId}`}
        initial={{ title: '', text: '' }}
        titleLabel="Title"
        textLabel="Instructions"
        submitLabel="Fork"
        textFirst
        onSubmit={props.onFork}
        onDone={props.onClose}
      />
    </Modal>
  );
}

export function EditPromptDialog(props: {
  readonly taskId: string;
  readonly opened: boolean;
  readonly initial: PromptValue;
  readonly onClose: () => void;
  readonly onSave: (value: PromptValue) => Promise<boolean>;
}): ReactNode {
  return (
    <Modal opened={props.opened} onClose={props.onClose} title="Edit prompt" centered size="lg">
      <PromptForm
        draftKey={`edit:${props.taskId}`}
        initial={props.initial}
        titleLabel="Title"
        textLabel="Prompt"
        submitLabel="Save"
        onSubmit={props.onSave}
        onDone={props.onClose}
      />
    </Modal>
  );
}

export function PolishDialog(props: {
  readonly rewrite: PolishRewrite | null;
  readonly parentTitle: string;
  readonly onClose: () => void;
  readonly onApply: (rewrite: PolishRewrite) => Promise<boolean>;
}): ReactNode {
  const { rewrite } = props;
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      opened={rewrite !== null}
      onClose={props.onClose}
      title="Apply the polished prompt?"
      centered
      size="lg"
    >
      {rewrite === null ? null : (
        <Stack>
          <Text size="sm">
            This replaces the title and prompt of {props.parentTitle}. The old text stays in its
            thread as a note.
          </Text>
          <Text fw={600}>{rewrite.title}</Text>
          <Markdown>{rewrite.prompt}</Markdown>
          <Group justify="flex-end">
            <Button variant="default" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void props.onApply(rewrite).then((ok) => {
                  setBusy(false);
                  if (ok) props.onClose();
                });
              }}
            >
              Apply prompt
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
