import type { HandlerSet } from '../http/handler.js';
import { eventsHandlers } from '../modules/events/index.js';
import { machineApiHandlers } from '../modules/machine/index.js';
import { passkeyHandlers } from './passkeys.js';
import { projectsSettingsHandlers } from './projects-settings/index.js';
import { publicHandlers } from './public.js';
import { redirectSignInHandlers } from './redirect-sign-in.js';
import { scheduleHandlers } from './schedules.js';
import { signatureHandlers } from './signature.js';
import { signInHandlers } from './sign-in.js';
import { taskActionHandlers } from './task-actions.js';
import { taskHandlers } from './tasks.js';

export const HANDLER_SETS: readonly HandlerSet[] = [
  publicHandlers,
  signInHandlers,
  redirectSignInHandlers,
  passkeyHandlers,
  projectsSettingsHandlers,
  eventsHandlers(),
  taskHandlers,
  taskActionHandlers,
  machineApiHandlers,
  scheduleHandlers,
  signatureHandlers,
];
