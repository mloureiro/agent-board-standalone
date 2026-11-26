import { Anchor, Button, Drawer, Group, Stack } from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

import { LockButton } from '../keys/index.js';
import { ProjectFilterSelect, ProjectsNav, useProjects } from '../projects/index.js';
import { ServerFilterSelect, ServersButton } from '../servers-dialog/index.js';
import { ColorSchemeMenu } from './ColorSchemeMenu.js';
import { focusPageStart } from './PageStart.js';
import { NewTaskButton } from './new-task.js';
import { SignOutButton } from './SignOutButton.js';

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
      onClick={() => {
        focusPageStart();
        onNavigate?.();
      }}
    >
      {item.label}
    </Anchor>
  ));
}

export function AppHeader(): ReactNode {
  const phone = usePhone();
  const projects = useProjects();
  const [menuOpen, { open, close }] = useDisclosure(false);
  return (
    <Group component="header" justify="space-between" wrap="wrap" gap="xs" px="md" py="xs">
      <Group gap="xs" wrap="wrap">
        {phone ? (
          <>
            <Button variant="default" onClick={open}>
              Menu
            </Button>
            {projects === null ? null : (
              <Button variant="default" onClick={open}>
                Projects
              </Button>
            )}
            <Drawer opened={menuOpen} onClose={close} title="Menu">
              <Stack>
                <Stack component="nav" aria-label="Main">
                  <NavLinks phone onNavigate={close} />
                </Stack>
                <ProjectsNav onNavigate={close} />
              </Stack>
            </Drawer>
          </>
        ) : (
          <Group component="nav" aria-label="Main" gap="md">
            <NavLinks phone={false} />
          </Group>
        )}
        <ServerFilterSelect />
        <ProjectFilterSelect />
      </Group>
      <Group gap="xs" wrap="wrap">
        <NewTaskButton />
        <ServersButton />
        <LockButton />
        <SignOutButton />
        <ColorSchemeMenu />
      </Group>
    </Group>
  );
}
