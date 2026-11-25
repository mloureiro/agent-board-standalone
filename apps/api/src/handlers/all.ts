import type { HandlerSet } from '../http/handler.js';
import { projectsSettingsHandlers } from './projects-settings/index.js';
import { publicHandlers } from './public.js';
import { signInHandlers } from './sign-in.js';

export const HANDLER_SETS: readonly HandlerSet[] = [
  publicHandlers,
  signInHandlers,
  projectsSettingsHandlers,
];
