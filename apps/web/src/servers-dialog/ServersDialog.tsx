import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useServers } from '../servers/index.js';
import { AddServerDialog } from './AddServerDialog.js';
import { ServerRow, type RowNotice } from './ServerRow.js';

function Notice(props: {
  readonly notice: RowNotice;
  readonly index: number;
  readonly onDismiss: () => void;
}): ReactNode {
  const { notice, index } = props;
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    element.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  return (
    <Alert ref={element} role="status" color="gray" variant="light" p="xs">
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Text size="sm">{notice.text}</Text>
        <Group gap="xs" wrap="nowrap">
          {notice.retry === undefined ? null : (
            <Button size="compact-xs" variant="default" onClick={notice.retry}>
              Retry
            </Button>
          )}
          <Button
            size="compact-xs"
            variant="subtle"
            aria-label={`Dismiss message ${index + 1}`}
            onClick={props.onDismiss}
          >
            Dismiss
          </Button>
        </Group>
      </Group>
    </Alert>
  );
}

export function ServersDialog(props: {
  readonly opened: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const { servers, select } = useServers();
  const [adding, setAdding] = useState(false);
  const [notices, setNotices] = useState<readonly RowNotice[]>([]);

  return (
    <>
      <Modal opened={props.opened} onClose={props.onClose} title="Servers" closeOnEscape={!adding}>
        <Stack gap="sm">
          {notices.length === 0 ? null : (
            <Stack
              gap={4}
              style={{
                position: 'sticky',
                top: 0,
                zIndex: 2,
                background: 'var(--mantine-color-body)',
              }}
            >
              {notices.map((notice, index) => (
                <Notice
                  key={`${index}:${notice.text}`}
                  notice={notice}
                  index={index}
                  onDismiss={() =>
                    setNotices((previous) => previous.filter((_, at) => at !== index))
                  }
                />
              ))}
            </Stack>
          )}
          {servers.length === 0 ? (
            <Text c="dimmed" size="sm">
              No servers yet. Add one to get started.
            </Text>
          ) : (
            <Stack component="ul" aria-label="Servers" gap="sm" p={0} m={0}>
              {servers.map((server) => (
                <ServerRow
                  key={server.id}
                  server={server}
                  onOpen={() => {
                    select(server.id);
                    props.onClose();
                  }}
                  onNotice={(notice) => setNotices((previous) => [...previous, notice])}
                />
              ))}
            </Stack>
          )}
          <Group justify="flex-end">
            <Button onClick={() => setAdding(true)}>Add server</Button>
          </Group>
        </Stack>
      </Modal>
      <AddServerDialog
        opened={props.opened && adding}
        onClose={() => setAdding(false)}
        onAdded={() => setNotices([])}
      />
    </>
  );
}
