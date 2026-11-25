import type { HandlerSet } from '../../http/handler.js';
import { clientHandlers } from './client-handlers.js';
import { machineHandlers } from './machine-handlers.js';
import { unavailableUserActions, type UserActions } from './user-commands.js';
import { userHandlers } from './user-handlers.js';

export const createMachineApiHandlers =
  (actions: UserActions = unavailableUserActions): HandlerSet =>
  () => ({ ...machineHandlers(), ...clientHandlers(), ...userHandlers(actions) });

export const machineApiHandlers: HandlerSet = createMachineApiHandlers();
