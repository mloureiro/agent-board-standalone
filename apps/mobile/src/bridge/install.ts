import { createMobileBridge, type TauriCore } from './shim.js';

declare global {
  interface Window {
    __TAURI__?: { core: TauriCore };
  }
}

if (window.__TAURI__ !== undefined && window.agentBoardBridge === undefined) {
  Object.defineProperty(window, 'agentBoardBridge', {
    value: Object.freeze(createMobileBridge(window.__TAURI__.core)),
    writable: false,
    configurable: false,
  });
}
