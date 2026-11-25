import { deleteClientAccountRoute, summaryClientAccountRoute } from '@agent-board/contract';
import { Alert, Button, Group, Modal, Stack, Text, TextInput, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';

import { messageOf } from '../../auth/messages.js';
import { downloadText } from '../../components/download.js';
import { useClock } from '../board/clock.js';
import { KeyProblem } from '../../keys/actions.js';
import { importExportedRows, parseAccountExport } from '../../keys/account-import.js';
import { useKeys } from '../../keys/KeysProvider.js';
import { usePage } from '../../pages/index.js';
import { notOffered, useServers } from '../../servers/index.js';
import { EXPORT_FILE, EXPORT_MEDIA_TYPE, buildAccountExport } from './account-export.js';
import { PasskeysSection } from './PasskeysSection.js';

export const OTHER_KEY = 'This file was exported with a different encryption key.';

function DataSection(): ReactNode {
  const page = usePage();
  const { active, clientOf, connectionOf } = useServers();
  const clock = useClock();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (page === null || active === null) return null;
  const offered = page.features.includes('board-export');
  const view = connectionOf(active.id);
  const serverVersion = 'server' in view ? view.server.server.version : 'unknown';

  const run = (kind: 'export' | 'import', work: () => Promise<string>): void => {
    setBusy(kind);
    setMessage(null);
    setError(null);
    work()
      .then(setMessage, (cause: unknown) =>
        setError(cause instanceof KeyProblem ? cause.message : messageOf(cause)),
      )
      .finally(() => setBusy(null));
  };

  const exportAccount = (): void =>
    run('export', async () => {
      const text = await buildAccountExport(
        page,
        page.keys.owner,
        serverVersion,
        new Date(clock()),
      );
      downloadText(EXPORT_FILE, text, EXPORT_MEDIA_TYPE);
      return 'The export was saved. It holds your data sealed with your key.';
    });

  const importAccount = (event: ChangeEvent<HTMLInputElement>): void => {
    const chosen = event.currentTarget.files?.item(0) ?? null;
    event.currentTarget.value = '';
    const client = clientOf(active.id);
    if (chosen === null || client === null) return;
    run('import', async () => {
      const exported = parseAccountExport(await chosen.text(), page.keys.owner);
      if (exported.setup.keyId !== page.keys.keyId) throw new KeyProblem(OTHER_KEY);
      const totals = await importExportedRows(client, exported);
      return `Imported ${totals.inserted} rows. ${totals.existing} were already here and ${totals.invalid + totals.orphaned} were skipped.`;
    });
  };

  return (
    <Stack gap="xs" component="section" aria-label="Your data">
      <Title order={2} size="h3">
        Your data
      </Title>
      {offered ? (
        <>
          <Group>
            <Button variant="default" loading={busy === 'export'} onClick={exportAccount}>
              Export
            </Button>
            <Button
              variant="default"
              loading={busy === 'import'}
              onClick={() => file.current?.click()}
            >
              Import
            </Button>
            <input
              ref={file}
              type="file"
              hidden
              aria-label="Import file"
              onChange={importAccount}
            />
          </Group>
          <Text size="sm" c="dimmed">
            The file holds everything sealed with your key. Import adds what the account does not
            have yet.
          </Text>
        </>
      ) : (
        <Text c="dimmed">{notOffered('board-export')}</Text>
      )}
      {message === null ? null : <Text role="status">{message}</Text>}
      {error === null ? null : (
        <Alert color="red" role="alert">
          {error}
        </Alert>
      )}
    </Stack>
  );
}

function DeleteDialog(props: {
  readonly opened: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const page = usePage();
  const { active, recheck } = useServers();
  const { lock } = useKeys();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summary = useQuery({
    queryKey: [...(page?.base ?? []), 'account-summary'],
    enabled: page !== null && props.opened,
    queryFn: async () => (page === null ? null : page.call(summaryClientAccountRoute, {})),
  });
  if (page === null || active === null) return null;
  const owner = page.keys.owner;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    page
      .call(deleteClientAccountRoute, { username: typed })
      .then(async () => {
        props.onClose();
        await lock();
        recheck(active.id);
      })
      .catch((cause: unknown) => setError(messageOf(cause)))
      .finally(() => setBusy(false));
  };

  const counts = summary.data;
  return (
    <Modal opened={props.opened} onClose={props.onClose} title="Delete account" centered>
      <form onSubmit={submit}>
        <Stack>
          <Text>
            This deletes {owner} and everything stored for it on this server. It cannot be undone.
            Export first if you want a copy.
          </Text>
          {counts === undefined || counts === null ? null : (
            <Text size="sm" c="dimmed">
              {counts.tasks} tasks, {counts.schedules} schedules, {counts.machines} machines and{' '}
              {counts.notes} notes.
              {counts.running > 0 ? ` ${counts.running} tasks are running.` : ''}
            </Text>
          )}
          <TextInput
            label="Type your username"
            value={typed}
            onChange={(event) => setTyped(event.currentTarget.value)}
            data-autofocus
          />
          {error === null ? null : (
            <Alert color="red" role="alert">
              {error}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" color="red" loading={busy} disabled={typed !== owner}>
              Delete account
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export function AccountPanel(): ReactNode {
  const [deleting, setDeleting] = useState(false);
  return (
    <Stack gap="lg" maw={720}>
      <PasskeysSection />
      <DataSection />
      <Stack gap="xs" component="section" aria-label="Account deletion">
        <Title order={2} size="h3">
          Delete account
        </Title>
        <Text size="sm" c="dimmed">
          Removes the account and all of its data from this server.
        </Text>
        <Group>
          <Button color="red" variant="default" onClick={() => setDeleting(true)}>
            Delete account
          </Button>
        </Group>
      </Stack>
      <DeleteDialog opened={deleting} onClose={() => setDeleting(false)} />
    </Stack>
  );
}
