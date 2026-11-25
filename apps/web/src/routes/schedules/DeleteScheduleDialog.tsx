import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useState, type ReactNode } from 'react';

import type { ScheduleView } from './schedule-model.js';

export function DeleteScheduleDialog(props: {
  readonly view: ScheduleView | null;
  readonly onClose: () => void;
  readonly onDelete: (view: ScheduleView) => Promise<unknown>;
}): ReactNode {
  const { view, onClose, onDelete } = props;
  const [busy, setBusy] = useState(false);
  const confirm = (): void => {
    if (view === null) return;
    setBusy(true);
    onDelete(view)
      .then(onClose, () => undefined)
      .finally(() => setBusy(false));
  };
  return (
    <Modal opened={view !== null} onClose={onClose} title="Delete schedule" centered>
      <Stack>
        <Text>{view?.title} will stop creating tasks. Tasks it already created stay.</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button color="red" loading={busy} onClick={confirm}>
            Delete
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
