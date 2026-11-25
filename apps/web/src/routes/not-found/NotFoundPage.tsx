import { Text } from '@mantine/core';
import type { ReactNode } from 'react';

import { PlaceholderPage } from '../PlaceholderPage.js';

export function NotFoundPage(): ReactNode {
  return (
    <PlaceholderPage title="Page not found">
      <Text>There is nothing at this address.</Text>
    </PlaceholderPage>
  );
}
