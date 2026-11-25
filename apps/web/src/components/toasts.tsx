import { Notification, Stack } from '@mantine/core';
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';

export interface Toast {
  readonly id: number;
  readonly message: string;
}

export interface ToastHub {
  push(message: string): void;
  dismiss(id: number): void;
  subscribe(listener: () => void): () => void;
  snapshot(): readonly Toast[];
}

export const createToastHub = (): ToastHub => {
  let toasts: readonly Toast[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  const emit = (): void => listeners.forEach((listener) => listener());
  return {
    push: (message) => {
      toasts = [...toasts, { id: nextId, message }];
      nextId += 1;
      emit();
    },
    dismiss: (id) => {
      toasts = toasts.filter((toast) => toast.id !== id);
      emit();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => toasts,
  };
};

const ToastContext = createContext<ToastHub | null>(null);

export const useToasts = (): ToastHub => {
  const hub = useContext(ToastContext);
  if (hub === null) throw new Error('useToasts needs a ToastProvider');
  return hub;
};

export function ToastProvider(props: { readonly hub: ToastHub; readonly children: ReactNode }) {
  return <ToastContext.Provider value={props.hub}>{props.children}</ToastContext.Provider>;
}

export function Toasts(): ReactNode {
  const hub = useToasts();
  const toasts = useSyncExternalStore(hub.subscribe, hub.snapshot);
  return (
    <Stack
      gap="xs"
      style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 1000, maxWidth: 360 }}
    >
      {toasts.map((toast) => (
        <Notification
          key={toast.id}
          color="red"
          role="alert"
          onClose={() => hub.dismiss(toast.id)}
          closeButtonProps={{ 'aria-label': 'Dismiss' }}
        >
          {toast.message}
        </Notification>
      ))}
    </Stack>
  );
}

export const useToastHub = (): ToastHub => useMemo(createToastHub, []);
