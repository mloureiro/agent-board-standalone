import {
  Drawer,
  Modal,
  createTheme,
  defaultVariantColorsResolver,
  type VariantColorsResolver,
} from '@mantine/core';

const CLOSE = { 'aria-label': 'Close dialog' };
const STILL = { transitionProps: { duration: 0 } };

const variantColorResolver: VariantColorsResolver = (input) => {
  const colors = defaultVariantColorsResolver(input);
  if (input.variant !== 'light') return colors;
  return {
    ...colors,
    color: `color-mix(in srgb, ${colors.color} 65%, var(--mantine-color-text))`,
  };
};

export const theme = createTheme({
  primaryColor: 'indigo',
  primaryShade: { light: 7, dark: 8 },
  defaultRadius: 'md',
  focusRing: 'always',
  variantColorResolver,
  components: {
    Modal: Modal.extend({ defaultProps: { closeButtonProps: CLOSE, ...STILL } }),
    Drawer: Drawer.extend({ defaultProps: { closeButtonProps: CLOSE, ...STILL } }),
  },
});
