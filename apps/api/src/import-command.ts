import { BoardExportError } from '@rumo/contract';

import {
  BoardImportRefusal,
  formatImportReport,
  importBoard,
  readBoardFile,
} from './modules/board-export/index.js';
import { DatabaseRefusal, openDatabase, type OpenDatabase } from './modules/database/index.js';
import { ConfigError, loadConfig, type Env } from './modules/index.js';

export interface ImportOptions {
  openDatabase?: OpenDatabase;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

const USAGE = 'usage: rumo-api import --file <path>';

const fileOf = (args: readonly string[]): string | null => {
  const [flag, value, ...rest] = args;
  if (flag === '--file' && value !== undefined && value !== '' && rest.length === 0) return value;
  if (rest.length === 0 && value === undefined && flag?.startsWith('--file=') === true) {
    return flag.slice('--file='.length) || null;
  }
  return null;
};

const isRefusal = (error: unknown): error is Error =>
  error instanceof ConfigError ||
  error instanceof DatabaseRefusal ||
  error instanceof BoardImportRefusal ||
  error instanceof BoardExportError ||
  (error instanceof Error && 'code' in error && error.code === 'ENOENT');

export const runImport = async (
  args: readonly string[],
  env: Env,
  options: ImportOptions = {},
): Promise<number> => {
  const out = options.out ?? ((text: string) => process.stdout.write(text));
  const err = options.err ?? ((text: string) => process.stderr.write(text));
  const file = fileOf(args);
  if (file === null) {
    err(`rumo-api: ${USAGE}\n`);
    return 2;
  }
  try {
    const config = loadConfig(env);
    const board = await readBoardFile(file);
    const database = await (options.openDatabase ?? openDatabase)(config.database);
    try {
      const reports = await importBoard(database, board, {
        noLoginUser: config.signIn.mode === 'no-login' ? config.signIn.user : null,
      });
      out(formatImportReport(reports));
    } finally {
      await database.close();
    }
    return 0;
  } catch (error) {
    err(
      `rumo-api: import failed: ${isRefusal(error) ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    return 1;
  }
};
