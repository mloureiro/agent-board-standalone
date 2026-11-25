import { detectSourceVersion, type SourceVersion } from './detect.js';
import { openSource } from './open.js';
import { countRows, type SourceTable } from './tables.js';

export interface InspectReport {
  readonly version: SourceVersion;
  readonly journal: number;
  readonly counts: ReadonlyMap<SourceTable, number>;
}

export async function inspectSource(location: string): Promise<InspectReport> {
  const reader = await openSource(location);
  try {
    const detected = await detectSourceVersion(reader);
    return {
      version: detected.version,
      journal: detected.journal,
      counts: await countRows(reader, detected.tables),
    };
  } finally {
    await reader.close();
  }
}

export function formatInspectReport(report: InspectReport): string {
  const lines = [`source version: ${report.version} (${report.journal} migrations)`];
  for (const [table, count] of report.counts) lines.push(`  ${table}: ${count}`);
  return `${lines.join('\n')}\n`;
}
