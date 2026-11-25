import { Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';

import { usePageTitle } from '../components/index.js';

export function PlaceholderPage(props: {
  readonly title: string;
  readonly children?: ReactNode;
}): ReactNode {
  usePageTitle(props.title);
  return (
    <>
      <Title order={1}>{props.title}</Title>
      {props.children ?? <Text c="dimmed">Nothing to show yet.</Text>}
    </>
  );
}
