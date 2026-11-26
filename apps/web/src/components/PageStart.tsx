import { useEffect, useRef, type ReactNode } from 'react';

import { useKeys } from '../keys/index.js';

const PAGE_START_ID = 'page-start';
const GATED = new Set(['locked', 'setup', 'forget']);

export function focusPageStart(): void {
  document.getElementById(PAGE_START_ID)?.focus({ preventScroll: true });
}

export function PageStart(): ReactNode {
  const status = useKeys().state.status;
  const previous = useRef(status);
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = anchor.current?.parentElement;
    if (container === null || container === undefined) return undefined;
    const sync = (): void => {
      container.inert = [...document.body.children].some(
        (child) => child !== container && child.querySelector('[aria-modal="true"]') !== null,
      );
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    sync();
    return () => {
      observer.disconnect();
      container.inert = false;
    };
  }, []);
  useEffect(() => {
    if (status === 'unlocked' && GATED.has(previous.current)) focusPageStart();
    previous.current = status;
  }, [status]);
  return <div ref={anchor} id={PAGE_START_ID} tabIndex={-1} style={{ outline: 'none' }} />;
}
