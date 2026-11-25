import { defineModule } from '../module.js';
import { cleanupSchema } from './config.js';
import { registerCleanup } from './register.js';

export { runCleanup, type CleanupDeps, type CleanupResult } from './run.js';
export {
  CLOSED_TRANSCRIPT_DAYS,
  DONE_ARCHIVE_DAYS,
  DONE_TRANSCRIPT_DAYS,
  archiveStaleDone,
  deleteOldTranscripts,
} from './retention.js';
export { CLEANUP_FIRST_RUN_MS, CLEANUP_INTERVAL_MS } from './register.js';

export const cleanupModule = defineModule({
  name: 'cleanup',
  schema: cleanupSchema,
  register: registerCleanup,
});
