import type { HandlerSet } from '../../http/handler.js';
import { clientHandlers } from './client-handlers.js';
import { machineHandlers } from './machine-handlers.js';
import { taskUserActions } from './task-user-actions.js';
import type { UserActions } from './user-commands.js';
import { userHandlers } from './user-handlers.js';

export const createMachineApiHandlers =
  (actions: UserActions = taskUserActions): HandlerSet =>
  () => ({ ...machineHandlers(), ...clientHandlers(), ...userHandlers(actions) });

export const machineApiHandlers: HandlerSet = createMachineApiHandlers();
