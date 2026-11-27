import { unlockKeys } from '@rumo/sealing';
import { Alert, Button, Stack, Text, TextInput, Title } from '@mantine/core';
import { useState, type FormEvent, type ReactNode } from 'react';

import { messageOf } from '../auth/messages.js';
import { useServers } from '../servers/index.js';
import { KeyProblem, WRONG_PASSPHRASE } from './actions.js';
import {
  importExportedRows,
  parseAccountExport,
  storeExportedSetup,
  type AccountExport,
} from './account-import.js';
import { useKeys } from './KeysProvider.js';
import { PassphraseField } from './PassphraseField.js';

export function ImportExport(props: {
  readonly owner: string;
  readonly onBack: () => void;
}): ReactNode {
  const { active, clientOf } = useServers();
  const { adopt } = useKeys();
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const client = active === null ? null : clientOf(active.id);
    if (client === null || file === null) return;
    setBusy(true);
    setError(null);
    try {
      const exported: AccountExport = parseAccountExport(await file.text(), props.owner);
      const keys = await unlockKeys(props.owner, exported.setup, {
        kind: 'passphrase',
        passphrase,
      }).catch(() => {
        throw new KeyProblem(WRONG_PASSPHRASE);
      });
      await storeExportedSetup(client, exported);
      await importExportedRows(client, exported);
      await adopt(keys);
    } catch (cause) {
      setError(cause instanceof KeyProblem ? cause.message : messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} aria-label="Import an account export">
      <Stack maw={480} mx="auto" p="md" gap="sm">
        <Title order={1}>Import an account export</Title>
        <Text>
          Choose the export file and enter the passphrase it was protected with. Your key and your
          data are restored.
        </Text>
        <TextInput
          type="file"
          label="Account export file"
          onChange={(event) => setFile(event.currentTarget.files?.item(0) ?? null)}
        />
        <PassphraseField
          label="Passphrase of the export"
          value={passphrase}
          onChange={setPassphrase}
          autoComplete="current-password"
        />
        {error === null ? null : (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        <Button type="submit" loading={busy} disabled={file === null || passphrase === ''}>
          Import
        </Button>
        <Button variant="subtle" onClick={props.onBack}>
          Back
        </Button>
      </Stack>
    </form>
  );
}
