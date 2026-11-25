import { Anchor, Button, Drawer, Group, Stack } from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

import { ColorSchemeMenu } from './ColorSchemeMenu.js';
import { NewTaskButton } from './new-task.js';

export const PHONE_QUERY = '(max-width: 48em)';

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly phoneOnly?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Board' },
  { to: '/backlog', label: 'Backlog', phoneOnly: true },
  { to: '/schedules', label: 'Schedules' },
  { to: '/closed', label: 'Closed' },
  { to: '/settings', label: 'Settings' },
];

export const usePhone = (): boolean =>
  useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false }) ?? false;

function NavLinks({ phone, onNavigate }: { phone: boolean; onNavigate?: () => void }): ReactNode {
  return NAV_ITEMS.filter((item) => phone || item.phoneOnly !== true).map((item) => (
    <Anchor
      key={item.to}
      component={NavLink}
      to={item.to}
      end={item.to === '/'}
      onClick={onNavigate}
    >
      {item.label}
    </Anchor>
  ));
}

function ProjectSwitcher(): ReactNode {
  return (
    <Button variant="default" disabled>
      Projects
    </Button>
  );
}

export function AppHeader(): ReactNode {
  const phone = usePhone();
  const [menuOpen, { open, close }] = useDisclosure(false);
  return (
    <Group component="header" justify="space-between" wrap="nowrap" px="md" py="xs">
      {phone ? (
        <>
          <Button variant="default" onClick={open}>
            Menu
          </Button>
          <Drawer opened={menuOpen} onClose={close} title="Menu">
            <Stack component="nav" aria-label="Main">
              <NavLinks phone onNavigate={close} />
              <ProjectSwitcher />
            </Stack>
          </Drawer>
        </>
      ) : (
        <Group component="nav" aria-label="Main" gap="md">
          <NavLinks phone={false} />
          <ProjectSwitcher />
        </Group>
      )}
      <Group gap="xs" wrap="nowrap">
        <NewTaskButton />
        <ColorSchemeMenu />
      </Group>
    </Group>
  );
}
