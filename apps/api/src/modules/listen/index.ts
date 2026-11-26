import { defineModule } from '../module.js';
import { listenSchema } from './config.js';
import { registerAllowedHosts } from './register.js';

export {
  ANY_HOST,
  DEFAULT_PORT,
  LOOPBACK_HOST,
  bareHostname,
  effectiveHost,
  ownHostNames,
  type ListenConfig,
} from './config.js';
export const listenModule = defineModule({
  name: 'listen',
  schema: listenSchema,
  register: registerAllowedHosts,
});
