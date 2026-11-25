import { Paper } from '@mantine/core';
import { useEffect, useState, type ReactNode } from 'react';

interface Inset {
  readonly bottom: number;
  readonly height: number | null;
}

const readInset = (): Inset => {
  const viewport = window.visualViewport as VisualViewport | null | undefined;
  if (viewport === null || viewport === undefined) return { bottom: 0, height: null };
  return {
    bottom: Math.max(0, Math.round(window.innerHeight - viewport.offsetTop - viewport.height)),
    height: viewport.height,
  };
};

export function useViewportInset(): Inset {
  const [inset, setInset] = useState<Inset>(readInset);
  useEffect(() => {
    const update = (): void => setInset(readInset());
    const viewport = window.visualViewport as VisualViewport | null | undefined;
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    update();
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  return inset;
}

export function PinnedPanel(props: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  const { bottom, height } = useViewportInset();
  return (
    <Paper
      component="section"
      aria-label={props.label}
      withBorder
      shadow="md"
      p="sm"
      radius="md"
      data-pinned-panel
      style={{
        position: 'sticky',
        bottom,
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--mantine-spacing-xs)',
        maxHeight: height === null ? '50dvh' : `${Math.floor(height / 2)}px`,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        background: 'var(--mantine-color-body)',
      }}
    >
      {props.children}
    </Paper>
  );
}
