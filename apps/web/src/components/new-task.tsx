import { Button } from '@mantine/core';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { NewTaskDialog } from '../new-task/index.js';

interface NewTaskValue {
  readonly opened: boolean;
  open(): void;
  close(): void;
}

const NewTaskContext = createContext<NewTaskValue | null>(null);

export const useNewTask = (): NewTaskValue => {
  const value = useContext(NewTaskContext);
  if (value === null) throw new Error('useNewTask needs a NewTaskProvider');
  return value;
};

const isTyping = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
};

export function NewTaskProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [opened, setOpened] = useState(false);
  const open = useCallback(() => setOpened(true), []);
  const close = useCallback(() => setOpened(false), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'c' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.defaultPrevented || isTyping(event.target)) return;
      event.preventDefault();
      setOpened(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const value = useMemo(() => ({ opened, open, close }), [opened, open, close]);
  return (
    <NewTaskContext.Provider value={value}>
      {children}
      <NewTaskDialog opened={opened} onClose={close} />
    </NewTaskContext.Provider>
  );
}

export function NewTaskButton(): ReactNode {
  const { open } = useNewTask();
  return <Button onClick={open}>New task</Button>;
}
