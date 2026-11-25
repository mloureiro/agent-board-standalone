import { Drawer, Modal, createTheme } from '@mantine/core';

const CLOSE = { 'aria-label': 'Close dialog' };

export const theme = createTheme({
  primaryColor: 'indigo',
  defaultRadius: 'md',
  focusRing: 'always',
  components: {
    Modal: Modal.extend({ defaultProps: { closeButtonProps: CLOSE } }),
    Drawer: Drawer.extend({ defaultProps: { closeButtonProps: CLOSE } }),
  },
});
