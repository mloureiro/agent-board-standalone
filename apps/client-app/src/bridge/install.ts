import { createBridge } from './bridge.js';
import { installHeartbeat } from './heartbeat.js';
import { currentWebviewLabel, call } from './invoke.js';
import { installBackspaceGuard } from './keyboard.js';
import { installRouting } from './routing.js';

const TAB_LABEL_PREFIX = 'tab-';

if (!Object.hasOwn(window, 'agentBoardBridge')) {
  Object.defineProperty(window, 'agentBoardBridge', {
    value: createBridge(),
    configurable: false,
    writable: false,
    enumerable: true,
  });
  installBackspaceGuard(window);
  const label = currentWebviewLabel();
  if (label?.startsWith(TAB_LABEL_PREFIX)) {
    installRouting({ target: window, label, report: call });
    installHeartbeat({ target: window, label, report: call });
  }
}
