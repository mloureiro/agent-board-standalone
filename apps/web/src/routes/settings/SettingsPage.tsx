import { Tabs, Title } from '@mantine/core';
import { useState, type ReactNode } from 'react';

import { usePageTitle } from '../../components/page-title.js';
import { DevicesPanel } from './DevicesPanel.js';
import { EncryptionPanel } from './EncryptionPanel.js';

export function SettingsPage(): ReactNode {
  const [tab, setTab] = useState<string | null>('encryption');
  usePageTitle('Settings');
  return (
    <>
      <Title order={1}>Settings</Title>
      <Tabs value={tab} onChange={setTab} mt="md" keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="encryption">Encryption</Tabs.Tab>
          <Tabs.Tab value="devices">Devices</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="encryption" pt="md">
          <EncryptionPanel />
        </Tabs.Panel>
        <Tabs.Panel value="devices" pt="md">
          <DevicesPanel />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
