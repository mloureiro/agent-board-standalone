import { Tabs, Title } from '@mantine/core';
import { useState, type ReactNode } from 'react';

import { usePageTitle } from '../../components/page-title.js';
import { AccountPanel } from './AccountPanel.js';
import { AgentsPanel } from './AgentsPanel.js';
import { DevicesPanel } from './DevicesPanel.js';
import { EncryptionPanel } from './EncryptionPanel.js';
import { FeedsPanel } from './FeedsPanel.js';
import { LinksPanel } from './LinksPanel.js';
import { MachinesPanel } from './MachinesPanel.js';
import { NotificationsPanel } from './NotificationsPanel.js';
import { TitlesPanel } from './TitlesPanel.js';
import { VersionsPanel } from './VersionsPanel.js';

interface Section {
  readonly value: string;
  readonly label: string;
  readonly panel: () => ReactNode;
}

export const SECTIONS: readonly Section[] = [
  { value: 'machines', label: 'Machines', panel: () => <MachinesPanel /> },
  { value: 'feeds', label: 'Feeds', panel: () => <FeedsPanel /> },
  { value: 'agents', label: 'Agents', panel: () => <AgentsPanel /> },
  { value: 'links', label: 'Links', panel: () => <LinksPanel /> },
  { value: 'titles', label: 'Titles', panel: () => <TitlesPanel /> },
  { value: 'notifications', label: 'Notifications', panel: () => <NotificationsPanel /> },
  { value: 'account', label: 'Account', panel: () => <AccountPanel /> },
  { value: 'encryption', label: 'Encryption', panel: () => <EncryptionPanel /> },
  { value: 'devices', label: 'Devices', panel: () => <DevicesPanel /> },
  { value: 'versions', label: 'Versions', panel: () => <VersionsPanel /> },
];

export function SettingsPage(): ReactNode {
  const [tab, setTab] = useState<string | null>(SECTIONS[0]?.value ?? null);
  usePageTitle('Settings');
  return (
    <>
      <Title order={1}>Settings</Title>
      <Tabs value={tab} onChange={setTab} mt="md" keepMounted={false}>
        <Tabs.List style={{ flexWrap: 'wrap' }}>
          {SECTIONS.map((section) => (
            <Tabs.Tab key={section.value} value={section.value}>
              {section.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {SECTIONS.map((section) => (
          <Tabs.Panel key={section.value} value={section.value} pt="md">
            {section.panel()}
          </Tabs.Panel>
        ))}
      </Tabs>
    </>
  );
}
