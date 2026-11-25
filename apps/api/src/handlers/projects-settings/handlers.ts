import type { HandlerSet } from '../../http/handler.js';
import { directoryHandlers } from './directories.js';
import { keyHandlers } from './keys.js';
import { projectHandlers } from './projects.js';
import { settingsHandlers } from './settings.js';

export const projectsSettingsHandlers: HandlerSet = (context) => ({
  ...keyHandlers(context),
  ...projectHandlers(context),
  ...directoryHandlers(context),
  ...settingsHandlers(context),
});
