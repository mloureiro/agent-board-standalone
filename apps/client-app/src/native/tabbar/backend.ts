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

export interface LayoutView {
  readonly panes: readonly PaneView[];
  readonly focused: number;
  readonly split: readonly number[];
}

export interface TabbarBackend {
  snapshot(): Promise<LayoutView>;
  select(tab: number): Promise<void>;
  close(tab: number): Promise<void>;
  cycle(direction: 'next' | 'previous'): Promise<void>;
  split(): Promise<void>;
  move(tab: number, pane: number): Promise<void>;
  closePane(pane: number): Promise<void>;
  focusPane(pane: number): Promise<void>;
  resize(divider: number, ratio: number, commit: boolean): Promise<void>;
  onChanged(handler: (view: LayoutView) => void): Promise<void>;
}

export const tauriBackend: TabbarBackend = {
  snapshot: () => command<LayoutView>('tabs_snapshot'),
  select: (tab) => command('tab_select', { tab }),
  close: (tab) => command('tab_close', { tab }),
  cycle: (dir) => command('tab_cycle', { dir }),
  split: () => command('tab_split'),
  move: (tab, pane) => command('tab_move', { tab, pane }),
  closePane: (pane) => command('pane_close', { pane }),
  focusPane: (pane) => command('pane_focus', { pane }),
  resize: (index, ratio, commit) => command('split_resize', { index, ratio, commit }),
  onChanged: async (handler) => {
    await getCurrentWebview().listen<LayoutView>('tabs-changed', (event) => {
      handler(event.payload);
    });
  },
};
