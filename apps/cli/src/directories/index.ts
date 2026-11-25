export { convertLegacyDirectories, reportLegacy } from './legacy.js';
export type { LegacyReport, LegacyUse } from './legacy.js';
export { writeDefaultProject, writeDirectories } from './edit.js';
export { coveringDirectory, normalizePath, readLocalDirectories } from './local.js';
export type { LocalDirectories, LocalDirectory } from './local.js';
export { machineDirectories, syncDirectories } from './sync.js';
export type { MachineDirectory, SyncOptions } from './sync.js';
