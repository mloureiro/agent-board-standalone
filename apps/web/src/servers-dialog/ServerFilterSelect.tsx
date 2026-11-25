import { Button, Combobox, useCombobox } from '@mantine/core';
import { useId, type ReactNode } from 'react';

import { useServers } from '../servers/index.js';

export const ALL_SERVERS_LABEL = 'All servers';
const ALL_VALUE = '';

export function ServerFilterSelect(): ReactNode {
  const listId = useId();
  const { servers, selection, select } = useServers();
  const combobox = useCombobox({ onDropdownClose: () => combobox.resetSelectedOption() });
  if (servers.length < 2) return null;
  const current = servers.find((server) => server.id === selection);
  return (
    <Combobox
      store={combobox}
      width={220}
      position="bottom-start"
      onOptionSubmit={(value) => {
        select(value === ALL_VALUE ? null : value);
        combobox.closeDropdown();
      }}
    >
      <Combobox.Target withAriaAttributes={false}>
        <Button
          variant="default"
          role="combobox"
          aria-label="Server"
          aria-haspopup="listbox"
          aria-expanded={combobox.dropdownOpened}
          aria-controls={listId}
          onClick={() => combobox.toggleDropdown()}
        >
          {current === undefined ? ALL_SERVERS_LABEL : current.name}
        </Button>
      </Combobox.Target>
      <Combobox.Dropdown>
        <Combobox.Options id={listId}>
          <Combobox.Option value={ALL_VALUE} active={current === undefined}>
            {ALL_SERVERS_LABEL}
          </Combobox.Option>
          {servers.map((server) => (
            <Combobox.Option key={server.id} value={server.id} active={server.id === selection}>
              {server.name}
            </Combobox.Option>
          ))}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}
