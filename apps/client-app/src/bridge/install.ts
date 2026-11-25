import { createBridge } from './bridge.js';

if (!Object.hasOwn(window, 'agentBoardBridge')) {
  Object.defineProperty(window, 'agentBoardBridge', {
    value: createBridge(),
    configurable: false,
    writable: false,
    enumerable: true,
  });
}
