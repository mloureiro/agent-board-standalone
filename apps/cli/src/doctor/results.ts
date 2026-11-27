import type { DoctorCheckId, DoctorResult } from '@rumo/contract';

import type { Context } from '../commands/context.js';

export type Check = (ctx: Context) => Promise<DoctorResult[]> | DoctorResult[];

export function pass(name: DoctorCheckId, message: string): DoctorResult {
  return { name, level: 'ok', message };
}

export function problem(
  name: DoctorCheckId,
  level: 'warn' | 'fail',
  message: string,
  hint?: string,
): DoctorResult {
  return { name, level, message, ...(hint === undefined ? {} : { hint }) };
}

export function formatResult(result: DoctorResult): string {
  const mark = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' }[result.level];
  const hint = result.hint === undefined ? '' : `\n          hint: ${result.hint}`;
  return `${mark}  ${result.name}: ${result.message}${hint}`;
}

export function hasFailure(results: readonly DoctorResult[]): boolean {
  return results.some((result) => result.level === 'fail');
}

export function summary(results: readonly DoctorResult[]): string {
  const count = (level: DoctorResult['level']): number =>
    results.filter((result) => result.level === level).length;
  return `${results.length} checks: ${count('ok')} ok, ${count('warn')} warnings, ${count('fail')} failures`;
}
