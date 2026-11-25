import { defineModule } from '../module.js';
import { envObject } from '../env.js';
import { registerHoldGate } from './register.js';

export const controlModule = defineModule({
  name: 'control',
  schema: envObject.transform((env): string | null => env.CONTROL_SOCKET ?? null),
  register: registerHoldGate,
});

export { createHoldGate, type HoldGate } from './hold-gate.js';
export { startControlSocket, type ControlSocket, type ControlTarget } from './socket.js';
export { requestPairCode } from './client.js';
