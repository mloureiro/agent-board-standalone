import { createContext, useContext, type ReactNode } from 'react';

export interface BrowserEnvironment {
  assign(url: string): void;
  openWindow(url: string): void;
  reload(): void;
}

export const defaultEnvironment: BrowserEnvironment = {
  assign: (url) => window.location.assign(url),
  openWindow: (url) => void window.open(url, '_blank', 'noopener'),
  reload: () => window.location.reload(),
};

const EnvironmentContext = createContext<BrowserEnvironment>(defaultEnvironment);

export const useEnvironment = (): BrowserEnvironment => useContext(EnvironmentContext);

export function EnvironmentProvider(props: {
  readonly value: BrowserEnvironment;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <EnvironmentContext.Provider value={props.value}>{props.children}</EnvironmentContext.Provider>
  );
}
