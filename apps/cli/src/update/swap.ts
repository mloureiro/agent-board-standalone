import { copyFileSync, chmodSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

export interface Replacement {
  readonly target: string;
  readonly source: string | null;
  readonly mode?: number;
}

function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

export function replaceAll(replacements: readonly Replacement[]): void {
  const suffix = `${process.pid}`;
  const staged: string[] = [];
  const done: { target: string; undo: string | null; placed: boolean }[] = [];
  try {
    const stagedFor = new Map<Replacement, string>();
    for (const replacement of replacements) {
      if (replacement.source === null) continue;
      const copy = `${replacement.target}.restore-${suffix}`;
      mkdirSync(path.dirname(replacement.target), { recursive: true });
      copyFileSync(replacement.source, copy);
      if (replacement.mode !== undefined) chmodSync(copy, replacement.mode);
      staged.push(copy);
      stagedFor.set(replacement, copy);
    }
    for (const replacement of replacements) {
      const entry: { target: string; undo: string | null; placed: boolean } = {
        target: replacement.target,
        undo: null,
        placed: false,
      };
      done.push(entry);
      if (exists(replacement.target)) {
        const undo = `${replacement.target}.undo-${suffix}`;
        renameSync(replacement.target, undo);
        entry.undo = undo;
      }
      const copy = stagedFor.get(replacement);
      if (copy !== undefined) {
        renameSync(copy, replacement.target);
        entry.placed = true;
      }
    }
  } catch (error) {
    for (const entry of done.reverse()) {
      if (entry.placed) rmSync(entry.target, { force: true });
      if (entry.undo !== null) renameSync(entry.undo, entry.target);
    }
    for (const copy of staged) rmSync(copy, { force: true });
    throw error;
  }
  for (const entry of done) if (entry.undo !== null) rmSync(entry.undo, { force: true });
}
