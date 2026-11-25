import { Button, Group, Modal, Stack, Textarea } from '@mantine/core';
import { useState, type ReactNode } from 'react';

import { useDraft } from '../../drafts/index.js';

export interface ProposalStart {
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

function StartForm(props: {
  readonly id: string;
  readonly initial: string;
  readonly onStart: (text: string) => void;
}): ReactNode {
  const [draft, setDraft] = useDraft(`proposal:${props.id}`, props.initial);
  const [text, setText] = useState(draft === '' ? props.initial : draft);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setDraft('');
        props.onStart(text);
      }}
    >
      <Stack>
        <Textarea
          label="Prompt"
          autosize
          minRows={5}
          value={text}
          onChange={(event) => {
            setText(event.currentTarget.value);
            setDraft(event.currentTarget.value === props.initial ? '' : event.currentTarget.value);
          }}
          data-autofocus
        />
        <Group justify="flex-end">
          <Button type="submit" disabled={text.trim() === ''}>
            Move to Todo
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

export function ProposalStartDialog(props: {
  readonly proposal: ProposalStart | null;
  readonly onClose: () => void;
  readonly onStart: (text: string) => void;
}): ReactNode {
  const { proposal } = props;
  return (
    <Modal
      opened={proposal !== null}
      onClose={props.onClose}
      title={proposal === null ? '' : `Start proposal: ${proposal.title}`}
      size="lg"
      centered
    >
      {proposal === null ? null : (
        <StartForm id={proposal.id} initial={proposal.text} onStart={props.onStart} />
      )}
    </Modal>
  );
}
