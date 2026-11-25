import { Alert, Button, Group, Stack } from '@mantine/core';
import type { ReactNode } from 'react';

import type { RulesEditor } from './use-rules-document.js';

export const CONFLICT_TEXT =
  'These rules were changed somewhere else since you opened them. Discard your edits to see the current rules.';

export function RulesFooter(props: {
  readonly editor: RulesEditor<unknown>;
  readonly invalid: boolean;
  readonly onAdd: () => void;
}): ReactNode {
  const { editor, invalid, onAdd } = props;
  return (
    <Stack gap="xs">
      {editor.conflict ? (
        <Alert color="red" role="alert">
          {CONFLICT_TEXT}
        </Alert>
      ) : null}
      {editor.error === null ? null : (
        <Alert color="red" role="alert">
          {editor.error}
        </Alert>
      )}
      <Group>
        <Button variant="default" onClick={onAdd}>
          Add rule
        </Button>
        <Button
          loading={editor.saving}
          disabled={!editor.dirty || invalid}
          onClick={() => void editor.save()}
        >
          Save rules
        </Button>
        <Button
          variant="subtle"
          disabled={!editor.dirty && !editor.conflict}
          onClick={() => void editor.discard()}
        >
          Discard changes
        </Button>
      </Group>
    </Stack>
  );
}
