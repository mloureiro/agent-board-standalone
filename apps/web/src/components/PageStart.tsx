import { useEffect, useRef, type ReactNode } from 'react';

import { useKeys } from '../keys/index.js';

const PAGE_START_ID = 'page-start';
const DIALOG_HOST_ID = 'dialog-host';
const GATED = new Set(['locked', 'setup', 'forget']);

export function focusPageStart(): void {
  document.getElementById(PAGE_START_ID)?.focus({ preventScroll: true });
}

export const dialogPortal = (): { target?: HTMLElement } => {
  const target = document.getElementById(DIALOG_HOST_ID);
  return target === null ? {} : { target };
};

export function PageStart(): ReactNode {
  const status = useKeys().state.status;
  const previous = useRef(status);
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      const link = event.target instanceof Element ? event.target.closest('a[href^="/"]') : null;
      if (link === null || event.defaultPrevented || event.button !== 0) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      focusPageStart();
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);
  useEffect(() => {
    if (status === 'unlocked' && GATED.has(previous.current)) focusPageStart();
    previous.current = status;
  }, [status]);
  return (
    <>
      <div id={PAGE_START_ID} tabIndex={-1} style={{ outline: 'none' }} />
      <div id={DIALOG_HOST_ID} />
    </>
  );
}
