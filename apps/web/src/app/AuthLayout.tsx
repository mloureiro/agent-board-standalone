import { Box } from '@mantine/core';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router';

import { Toasts } from '../components/index.js';

export function AuthLayout(): ReactNode {
  return (
    <Box component="main" p="md">
      <Outlet />
      <Toasts />
    </Box>
  );
}
