import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  BOARD_EXPORT_FORMAT,
  BOARD_EXPORT_VERSION,
  parseBoardExportLine,
} from '@agent-board/contract';
import { buildPlan, type PlanReport } from './plan.js';
import { detectSourceVersion } from './source/detect.js';
import { openSource } from './source/open.js';
import type { SourceReader } from './source/reader.js';
import { exportRecords } from './transform/records.js';

export async function writeExport(reader: SourceReader, outFile: string): Promise<PlanReport> {
  const detected = await detectSourceVersion(reader);
  await mkdir(dirname(outFile), { recursive: true });
  const out = createWriteStream(outFile, { encoding: 'utf8', mode: 0o600 });
  const failed = once(out, 'error').then(([error]) => Promise.reject(error as Error));
  failed.catch(() => undefined);
  const write = async (value: unknown, index: number, context: string): Promise<void> => {
    const line = JSON.stringify(value);
    try {
      parseBoardExportLine(line, index);
    } catch (error) {
      throw new Error(`${context}: ${(error as Error).message}`, { cause: error });
    }
    if (!out.write(`${line}\n`)) await Promise.race([once(out, 'drain'), failed]);
  };
  const counts = new Map<string, Map<string, number>>();
  try {
    await write(
      {
        format: BOARD_EXPORT_FORMAT,
        version: BOARD_EXPORT_VERSION,
        createdAt: new Date().toISOString(),
        source: { kind: 'migrate', version: detected.version },
      },
      0,
      'header',
    );
    let index = 1;
    for await (const record of exportRecords(reader, detected)) {
      await write(
        { owner: record.owner, table: record.table, row: record.row },
        index,
        `owner ${record.owner}, table ${record.table}`,
      );
      index += 1;
      const perOwner = counts.get(record.owner) ?? new Map<string, number>();
      counts.set(record.owner, perOwner);
      perOwner.set(record.count, (perOwner.get(record.count) ?? 0) + 1);
    }
    out.end();
    await Promise.race([once(out, 'finish'), failed]);
  } catch (error) {
    out.destroy();
    await rm(outFile, { force: true });
    throw error;
  }
  return buildPlan(detected.version, counts);
}

export async function exportSource(location: string, outFile: string): Promise<PlanReport> {
  const reader = await openSource(location);
  try {
    return await writeExport(reader, outFile);
  } finally {
    await reader.close();
  }
}
