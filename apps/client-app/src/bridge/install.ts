import { createBridge } from './bridge.js';
import { currentWebviewLabel, call } from './invoke.js';
import { installRouting } from './routing.js';

const TAB_LABEL_PREFIX = 'tab-';

if (!Object.hasOwn(window, 'agentBoardBridge')) {
  Object.defineProperty(window, 'agentBoardBridge', {
    value: createBridge(),
    configurable: false,
    writable: false,
    enumerable: true,
  });
  const label = currentWebviewLabel();
  if (label?.startsWith(TAB_LABEL_PREFIX)) {
    installRouting({ target: window, label, report: call });
  }
}
