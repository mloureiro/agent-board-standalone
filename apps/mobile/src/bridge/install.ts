import { createMobileBridge, type TauriCore } from './shim.js';

interface LaunchTarget {
  takeTask(): string;
}

declare global {
  interface Window {
    __TAURI__?: { core: TauriCore };
    AgentBoardLaunch?: LaunchTarget;
  }
}

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

if (window.__TAURI__ !== undefined && window.agentBoardBridge === undefined) {
  Object.defineProperty(window, 'agentBoardBridge', {
    value: Object.freeze(createMobileBridge(window.__TAURI__.core)),
    writable: false,
    configurable: false,
  });
  const task = window.AgentBoardLaunch?.takeTask() ?? '';
  if (TASK_ID.test(task)) window.history.replaceState(null, '', `/tasks/${task}`);
}
