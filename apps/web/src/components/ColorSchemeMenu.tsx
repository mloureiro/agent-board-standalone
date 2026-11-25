import { Button, Menu, useMantineColorScheme, type MantineColorScheme } from '@mantine/core';
import type { ReactNode } from 'react';

const CHOICES: readonly { value: MantineColorScheme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'auto', label: 'System' },
];

export function ColorSchemeMenu(): ReactNode {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  return (
    <Menu position="bottom-end">
      <Menu.Target>
        <Button variant="default">
          Colour scheme: {CHOICES.find((choice) => choice.value === colorScheme)?.label}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {CHOICES.map((choice) => (
          <Menu.Item
            key={choice.value}
            aria-current={colorScheme === choice.value}
            onClick={() => setColorScheme(choice.value)}
          >
            {choice.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
