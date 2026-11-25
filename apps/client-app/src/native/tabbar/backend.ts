import { getCurrentWebview } from '@tauri-apps/api/webview';

import { command } from '../shared/invoke.js';

export interface TabView {
  readonly id: number;
  readonly label: string;
  readonly home: boolean;
}

export interface PaneView {
  readonly selected: number;
  readonly tabs: readonly TabView[];
}

export interface TabbarBackend {
  snapshot(): Promise<PaneView>;
  select(tab: number): Promise<void>;
  close(tab: number): Promise<void>;
  cycle(direction: 'next' | 'previous'): Promise<void>;
  onChanged(handler: (view: PaneView) => void): Promise<void>;
}

export const tauriBackend: TabbarBackend = {
  snapshot: () => command<PaneView>('tabs_snapshot'),
  select: (tab) => command('tab_select', { tab }),
  close: (tab) => command('tab_close', { tab }),
  cycle: (dir) => command('tab_cycle', { dir }),
  onChanged: async (handler) => {
    await getCurrentWebview().listen<PaneView>('tabs-changed', (event) => {
      handler(event.payload);
    });
  },
};
