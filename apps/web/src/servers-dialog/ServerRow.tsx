import { ActionIcon, Button, Group, Menu, Stack, Text, TextInput } from '@mantine/core';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import {
  BLANK_NAME_MESSAGE,
  describeConnection,
  reachesHttpFromHttps,
  checkConnection,
  useServers,
  type ServerEntry,
} from '../servers/index.js';

const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

const STOP_ESCAPE = { 'data-mantine-stop-propagation': 'true' } as const;

export interface RowNotice {
  readonly text: string;
  readonly retry?: () => void;
}

export function ServerRow(props: {
  readonly server: ServerEntry;
  readonly onOpen: () => void;
  readonly onNotice: (notice: RowNotice) => void;
}): ReactNode {
  const { server, onOpen, onNotice } = props;
  const { connectionOf, transportOf, transportContext, removeServer, renameServer, recheck } =
    useServers();
  const view = connectionOf(server.id);
  const connecting = view.state === 'checking';
  const row = useRef<HTMLDivElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const renameField = useRef<HTMLInputElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameProblem, setRenameProblem] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (armed) confirmButton.current?.focus();
  }, [armed]);

  useEffect(() => {
    if (!armed) return undefined;
    const outside = (event: Event): void => {
      if (!row.current?.contains(event.target as Node)) setArmed(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [armed]);

  const test = async (): Promise<void> => {
    const transport = transportOf(server.id);
    if (transport === null) return;
    setTesting(true);
    setResult(null);
    const state = await checkConnection({ transport, hasBoundKey: async () => true });
    setTesting(false);
    setResult(
      describeConnection(state, {
        blockedLoopback: reachesHttpFromHttps(transportContext.pageOrigin, server.url),
      }),
    );
    recheck(server.id);
  };

  const cancelRename = (): void => {
    setRenaming(null);
    setRenameProblem(null);
    setTimeout(() => renameButton.current?.focus(), 0);
  };

  const saveRename = async (): Promise<void> => {
    if (renaming === null) return;
    if (renaming.trim() === '') {
      setRenameProblem(BLANK_NAME_MESSAGE);
      renameField.current?.focus();
      return;
    }
    await renameServer(server.id, renaming);
    setRenaming(null);
    setRenameProblem(null);
    setTimeout(() => renameButton.current?.focus(), 0);
  };

  const onRenameKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    cancelRename();
  };

  const remove = async (): Promise<void> => {
    setRemoving(true);
    try {
      const removed = await removeServer(server.id);
      if (removed) onNotice({ text: `Removed ${server.name}.` });
    } catch {
      setArmed(false);
      onNotice({
        text: `Couldn't delete the stored data of ${server.name}.`,
        retry: () => void removeServer(server.id).catch(() => undefined),
      });
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Group
      component="li"
      ref={row}
      wrap="wrap"
      justify="space-between"
      align="flex-start"
      gap="xs"
      style={{ listStyle: 'none' }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (
          armed &&
          next instanceof Element &&
          !row.current?.contains(next) &&
          next.matches(FOCUSABLE)
        )
          setArmed(false);
      }}
    >
      <Stack gap={2} style={{ minWidth: 0, flex: '1 1 12rem' }}>
        {renaming === null ? (
          <Text fw={600} size="sm" truncate>
            {server.name}
          </Text>
        ) : (
          <Group gap="xs" wrap="nowrap" align="flex-start" onKeyDown={onRenameKey}>
            <TextInput
              ref={renameField}
              aria-label={`New name for ${server.name}`}
              value={renaming}
              error={renameProblem}
              onChange={(event) => setRenaming(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void saveRename();
                }
              }}
              data-autofocus
              autoFocus
              {...STOP_ESCAPE}
            />
            <Button size="compact-sm" onClick={() => void saveRename()} {...STOP_ESCAPE}>
              Save
            </Button>
            <Button size="compact-sm" variant="default" onClick={cancelRename} {...STOP_ESCAPE}>
              Cancel
            </Button>
          </Group>
        )}
        <Text size="xs" c="dimmed" truncate title={server.url}>
          {server.url}
        </Text>
        {result === null ? null : (
          <Text size="xs" role="status">
            {result}
          </Text>
        )}
      </Stack>
      <Group gap="xs" wrap="wrap">
        {armed ? (
          <>
            <Button
              ref={confirmButton}
              color="red"
              size="compact-sm"
              loading={removing}
              aria-label={`Confirm remove ${server.name}`}
              onClick={() => void remove()}
            >
              Confirm remove
            </Button>
            <Button
              size="compact-sm"
              variant="default"
              aria-label={`Cancel remove ${server.name}`}
              onClick={() => setArmed(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              size="compact-sm"
              disabled={connecting}
              aria-label={`Open ${server.name}`}
              onClick={onOpen}
            >
              {connecting ? 'Connecting…' : 'Open'}
            </Button>
            <Button
              size="compact-sm"
              variant="default"
              disabled={testing}
              aria-label={`Test ${server.name}`}
              onClick={() => void test()}
            >
              {testing ? 'Testing…' : 'Test'}
            </Button>
            <Button
              ref={renameButton}
              size="compact-sm"
              variant="default"
              aria-label={`Rename ${server.name}`}
              onClick={() => setRenaming(server.name)}
            >
              Rename
            </Button>
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray" aria-label={`Actions ${server.name}`}>
                  <span aria-hidden="true">⋯</span>
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item color="red" onClick={() => setArmed(true)}>
                  Remove
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </>
        )}
      </Group>
    </Group>
  );
}
