import { Button } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import type { ReactNode } from 'react';

import { ServersDialog } from './ServersDialog.js';

export function ServersButton(): ReactNode {
  const [opened, { open, close }] = useDisclosure(false);
  return (
    <>
      <Button variant="default" onClick={open}>
        Servers
      </Button>
      <ServersDialog opened={opened} onClose={close} />
    </>
  );
}
