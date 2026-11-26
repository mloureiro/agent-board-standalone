import { Box } from '@mantine/core';
import type { ReactNode } from 'react';

import { tokensText, type ContextUsage } from './context-model.js';

export function ContextLine(props: { readonly usage: ContextUsage }): ReactNode {
  const { usage } = props;
  return (
    <Box
      role="progressbar"
      aria-label="Context usage"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={usage.percent}
      aria-valuetext={`${usage.percent}% of ${tokensText(usage.window)} tokens`}
      h={3}
      bg="var(--mantine-color-default-border)"
      style={{ borderRadius: 2, overflow: 'hidden' }}
    >
      <Box h="100%" w={`${usage.percent}%`} bg="var(--mantine-color-blue-6)" />
    </Box>
  );
}
