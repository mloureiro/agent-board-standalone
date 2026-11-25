import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { ADDRESS_PROBLEM_MESSAGES, BLANK_NAME_MESSAGE, useServers } from '../servers/index.js';
import { testAddress } from './test-address.js';

type Notice = { readonly tone: 'problem' | 'result'; readonly text: string };

export function AddServerDialog(props: {
  readonly opened: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const { opened, onClose } = props;
  const { addServer, transportContext } = useServers();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);
  const addressField = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const backdropPress = useRef(false);

  useEffect(() => {
    if (!opened) return;
    generation.current += 1;
    setName('');
    setAddress('');
    setNotice(null);
    setAdding(false);
    setTesting(false);
  }, [opened]);

  const close = (): void => {
    generation.current += 1;
    onClose();
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (adding) return;
    if (name.trim() === '') {
      setNotice({ tone: 'problem', text: BLANK_NAME_MESSAGE });
      nameField.current?.focus();
      return;
    }
    const attempt = generation.current;
    setAdding(true);
    setNotice(null);
    void addServer({ name, address }).then(
      (added) => {
        if (attempt !== generation.current) return;
        setAdding(false);
        if (added.ok) {
          setName('');
          setAddress('');
          setNotice(null);
          onClose();
          return;
        }
        setNotice({ tone: 'problem', text: ADDRESS_PROBLEM_MESSAGES[added.problem] });
        addressField.current?.focus();
      },
      (cause: unknown) => {
        if (attempt !== generation.current) return;
        setAdding(false);
        setNotice({
          tone: 'problem',
          text:
            cause instanceof Error && cause.message !== ''
              ? cause.message
              : 'The server was not added.',
        });
      },
    );
  };

  const test = (): void => {
    const attempt = generation.current;
    setTesting(true);
    setNotice(null);
    void testAddress(address, transportContext).then((outcome) => {
      if (attempt !== generation.current) return;
      setTesting(false);
      setNotice({ tone: outcome.kind === 'invalid' ? 'problem' : 'result', text: outcome.message });
      if (outcome.kind === 'invalid') addressField.current?.focus();
    });
  };

  const pressedBackdrop = (event: MouseEvent): void => {
    backdropPress.current = event.target === event.currentTarget;
  };
  const releasedBackdrop = (event: MouseEvent): void => {
    const pressed = backdropPress.current;
    backdropPress.current = false;
    if (pressed && event.target === event.currentTarget) close();
  };

  return (
    <Modal
      opened={opened}
      onClose={close}
      title="Add server"
      closeOnClickOutside={false}
      overlayProps={{ onMouseDown: pressedBackdrop, onClick: releasedBackdrop }}
      trapFocus
    >
      <form onSubmit={submit} noValidate>
        <Stack>
          <TextInput
            ref={nameField}
            label="Name"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            data-autofocus
            autoComplete="off"
          />
          <TextInput
            ref={addressField}
            label="Address"
            value={address}
            onChange={(event) => setAddress(event.currentTarget.value)}
            autoComplete="off"
            inputMode="url"
          />
          {notice === null ? null : notice.tone === 'problem' ? (
            <Alert color="red" role="alert">
              {notice.text}
            </Alert>
          ) : (
            <Text role="status" size="sm">
              {notice.text}
            </Text>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button variant="default" onClick={test} disabled={testing} aria-label="Test">
              {testing ? 'Testing…' : 'Test'}
            </Button>
            <Button type="submit" loading={adding} aria-label="Add">
              {adding ? 'Adding…' : 'Add'}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
