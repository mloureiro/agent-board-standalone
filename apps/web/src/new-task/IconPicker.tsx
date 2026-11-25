import { Button, Group, Popover, SimpleGrid, UnstyledButton } from '@mantine/core';
import { useState, type ReactNode } from 'react';

export const ICONS = [
  '🚀',
  '🐛',
  '✨',
  '🔧',
  '📝',
  '🧪',
  '🔍',
  '📦',
  '🔒',
  '⚡',
  '🎨',
  '📈',
  '🧹',
  '📚',
  '🌐',
  '💡',
  '🔥',
  '✅',
  '⚠️',
  '🗑️',
  '🔌',
  '🧩',
  '🛠️',
  '🏗️',
] as const;

export function IconPicker(props: {
  readonly value: string;
  readonly onChange: (icon: string) => void;
}): ReactNode {
  const [opened, setOpened] = useState(false);
  const choose = (icon: string): void => {
    props.onChange(icon);
    setOpened(false);
  };
  return (
    <Popover opened={opened} onChange={setOpened} withinPortal={false} position="bottom-start">
      <Popover.Target>
        <Button
          variant="default"
          aria-label="Icon"
          aria-haspopup="dialog"
          aria-expanded={opened}
          onClick={() => setOpened((current) => !current)}
        >
          {props.value === '' ? 'Choose icon' : props.value}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <SimpleGrid cols={6} spacing={4}>
          {ICONS.map((icon) => (
            <UnstyledButton key={icon} onClick={() => choose(icon)} fz="xl" ta="center" p={4}>
              {icon}
            </UnstyledButton>
          ))}
        </SimpleGrid>
        <Group justify="flex-end" mt="xs">
          <Button size="compact-xs" variant="subtle" onClick={() => choose('')}>
            No icon
          </Button>
        </Group>
      </Popover.Dropdown>
    </Popover>
  );
}
