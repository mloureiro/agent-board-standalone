import { Button, Group, Popover, SimpleGrid, Stack, Text, UnstyledButton } from '@mantine/core';
import { useState, type ReactNode } from 'react';

import { ICONS, iconLabel } from '../components/icon-label.js';

export function IconPicker(props: {
  readonly value: string;
  readonly onChange: (icon: string) => void;
  readonly recent?: readonly string[];
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
        {props.recent === undefined || props.recent.length === 0 ? null : (
          <Stack gap={4} mb="xs" role="group" aria-label="Recent icons">
            <Text size="xs" c="dimmed">
              Recent
            </Text>
            <SimpleGrid cols={6} spacing={4}>
              {props.recent.map((icon) => (
                <UnstyledButton
                  key={icon}
                  aria-label={iconLabel(icon)}
                  onClick={() => choose(icon)}
                  fz="xl"
                  ta="center"
                  p={4}
                >
                  {icon}
                </UnstyledButton>
              ))}
            </SimpleGrid>
          </Stack>
        )}
        <SimpleGrid cols={6} spacing={4}>
          {ICONS.map((icon) => (
            <UnstyledButton
              key={icon}
              aria-label={iconLabel(icon)}
              onClick={() => choose(icon)}
              fz="xl"
              ta="center"
              p={4}
            >
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
