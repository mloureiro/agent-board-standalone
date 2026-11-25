import { CliError, UsageError } from '../errors.js';

const PREFIX_LENGTHS = [3, 4, 5, 6, 7, 9, 10, 11] as const;

export interface IdResolution {
  readonly inRun: boolean;
  readonly serverUrl: string;
  listIds(): Promise<readonly string[]>;
}

export function idFromLink(input: string, serverUrl: string): string | null {
  const base = serverUrl.replace(/\/+$/, '');
  if (!input.startsWith(`${base}/t/`)) return null;
  const rest = input.slice(base.length + 3).split(/[/?#]/)[0] ?? '';
  return rest === '' ? null : rest;
}

export function isPrefixLength(length: number): boolean {
  return (PREFIX_LENGTHS as readonly number[]).includes(length);
}

export async function resolveTaskId(input: string, resolution: IdResolution): Promise<string> {
  const linked = idFromLink(input, resolution.serverUrl);
  if (resolution.inRun) {
    if (linked !== null || isPrefixLength(input.length)) {
      throw new UsageError(
        'inside a run a task is named by its full id, not by a prefix or a link',
      );
    }
    return input;
  }
  const candidate = linked ?? input;
  if (!isPrefixLength(candidate.length)) return candidate;

  const ids = await resolution.listIds();
  if (ids.includes(candidate)) return candidate;
  const matches = ids.filter((id) => id.startsWith(candidate));
  const [only] = matches;
  if (only !== undefined && matches.length === 1) return only;
  if (matches.length === 0) throw new CliError(`no task id starts with "${candidate}"`);
  throw new CliError(
    `"${candidate}" matches ${matches.length} tasks (${matches.slice(0, 5).join(', ')}); use more characters`,
  );
}
