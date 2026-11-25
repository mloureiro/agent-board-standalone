import { Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';

import type { ConnectionView } from '../servers/index.js';
import { usePageTitle } from './page-title.js';

interface PanelContent {
  readonly title: string;
  readonly text: string;
}

export const panelFor = (view: ConnectionView): PanelContent | null => {
  switch (view.state) {
    case 'too-old':
      return { title: 'Client too old', text: view.message };
    case 'too-new':
      return { title: 'Server too old', text: view.message };
    default:
      return null;
  }
};

export function ServerStatePanel({ content }: { readonly content: PanelContent }): ReactNode {
  usePageTitle(content.title);
  return (
    <Stack role="region" aria-label={content.title} p="md">
      <Title order={1}>{content.title}</Title>
      <Text>{content.text}</Text>
    </Stack>
  );
}
