import { Button, Group, Modal, Stack, Textarea } from '@mantine/core';
import { useState, type ReactNode } from 'react';

export interface ProposalStart {
  readonly title: string;
  readonly text: string;
}

function StartForm(props: {
  readonly initial: string;
  readonly onStart: (text: string) => void;
}): ReactNode {
  const [text, setText] = useState(props.initial);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        props.onStart(text);
      }}
    >
      <Stack>
        <Textarea
          label="Prompt"
          autosize
          minRows={5}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
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
      {proposal === null ? null : <StartForm initial={proposal.text} onStart={props.onStart} />}
    </Modal>
  );
}
