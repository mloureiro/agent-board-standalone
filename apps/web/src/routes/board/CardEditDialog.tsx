import { Button, Group, Modal, Stack, TextInput } from '@mantine/core';
import { useState, type ReactNode } from 'react';

import type { BoardCard } from './card-model.js';

export type CardEdit = 'icon' | 'labels';

export interface CardEditValue {
  readonly icon?: string | null;
  readonly labels?: readonly string[] | null;
}

function EditForm(props: {
  readonly edit: CardEdit;
  readonly initial: string;
  readonly onSave: (value: CardEditValue) => void;
}): ReactNode {
  const { edit, onSave } = props;
  const [text, setText] = useState(props.initial);
  const submit = (): void => {
    const value = text.trim();
    if (edit === 'icon') {
      onSave({ icon: value === '' ? null : value });
      return;
    }
    const labels = value
      .split(',')
      .map((label) => label.trim())
      .filter((label) => label !== '');
    onSave({ labels: labels.length === 0 ? null : labels });
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Stack>
        <TextInput
          label={edit === 'icon' ? 'Icon' : 'Labels'}
          description={edit === 'labels' ? 'Separate labels with commas' : undefined}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          data-autofocus
        />
        <Group justify="flex-end">
          <Button type="submit">Save</Button>
        </Group>
      </Stack>
    </form>
  );
}

export function CardEditDialog(props: {
  readonly card: BoardCard;
  readonly edit: CardEdit | null;
  readonly onClose: () => void;
  readonly onSave: (value: CardEditValue) => void;
}): ReactNode {
  const { card, edit, onClose, onSave } = props;
  return (
    <Modal
      opened={edit !== null}
      onClose={onClose}
      title={edit === 'icon' ? 'Change icon' : 'Change labels'}
      centered
    >
      {edit === null ? null : (
        <EditForm
          key={edit}
          edit={edit}
          initial={edit === 'icon' ? (card.icon ?? '') : card.labels.join(', ')}
          onSave={(value) => {
            onSave(value);
            onClose();
          }}
        />
      )}
    </Modal>
  );
}
