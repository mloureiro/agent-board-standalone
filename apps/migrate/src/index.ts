export { PART_NAME, PART_VERSION } from './version.js';
export { run, main, UsageError } from './cli.js';
export { exportSource, writeExport } from './export-file.js';
export { buildPlan, formatPlan, type PlanReport } from './plan.js';
export { openSource } from './source/open.js';
export { inspectSource, formatInspectReport, type InspectReport } from './source/inspect.js';
export {
  detectSourceVersion,
  SOURCE_VERSIONS,
  type DetectedSource,
  type SourceVersion,
} from './source/detect.js';
export { SourceError, type SourceReader, type SourceRow } from './source/reader.js';
export { SOURCE_TABLES, type SourceTable } from './source/tables.js';
export { exportRecords, type ExportRecordInput } from './transform/records.js';
export { runMigration, type RunOptions } from './run/run-command.js';
export { CountCheckFailure, ImportFailure, RunRefusal } from './run/errors.js';
export {
  compareCounts,
  formatDifferences,
  type CountDifference,
  type OwnerCounts,
} from './run/count-check.js';
export { parseImportReport, runApiImport, type ImportReport } from './run/import-api.js';
export {
  checkOwners,
  importEnv,
  parseTarget,
  refuseHeldTarget,
  signInRuleOf,
} from './run/target.js';
