import {
  EFFORTS,
  PRIORITIES,
  SEALED_LIMITS,
  TASK_STATUSES,
  laneName,
  modelName,
  type Effort,
  type Priority,
  type SealedField,
  type TaskStatus,
} from '@rumo/contract';

import { UsageError } from '../errors.js';

const PR_URL = String.raw`https://github\.com/[\w.-]+/[\w.-]+/pull/\d+`;

export function isPrUrl(value: string): boolean {
  return new RegExp(`^${PR_URL}$`).test(value);
}

export function prUrlIn(input: string): string | undefined {
  return new RegExp(PR_URL).exec(input.split('\n')[0] ?? '')?.[0];
}

export function checkedPrUrl(url: string): string {
  if (!isPrUrl(url)) {
    throw new UsageError(
      `"${url.slice(0, 80)}" is not a pull request URL: use https://github.com/<owner>/<repo>/pull/<number>`,
    );
  }
  return url;
}

export function parseStatus(name: string): TaskStatus {
  const normalised = name.trim().toLowerCase().replaceAll(' ', '-');
  const found = TASK_STATUSES.find((status) => status === normalised);
  if (found === undefined) {
    throw new UsageError(`unknown status "${name}"; use one of ${TASK_STATUSES.join(', ')}`);
  }
  return found;
}

export function parsePriority(value: string): Priority {
  const found = PRIORITIES.find((priority) => priority === value);
  if (found === undefined) {
    throw new UsageError(
      `priority is one of ${PRIORITIES.join(', ')}, not "${value.slice(0, 40)}"`,
    );
  }
  return found;
}

export function parseEffort(value: string): Effort {
  const found = EFFORTS.find((effort) => effort === value);
  if (found === undefined) {
    throw new UsageError(`effort is one of ${EFFORTS.join(', ')}, not "${value.slice(0, 40)}"`);
  }
  return found;
}

export function checkedModel(value: string): string {
  if (!modelName.safeParse(value).success) {
    throw new UsageError(
      `"${value.slice(0, 40)}" is not a model name: use an alias such as opus, or a full model id`,
    );
  }
  return value;
}

export const LANE_RULE =
  'letters, digits, dots, dashes and underscores, at most 64 characters, starting with a letter or a digit';

export function checkedLane(value: string): string {
  if (!laneName.safeParse(value).success) {
    throw new UsageError(`"${value.slice(0, 40)}" is not a lane name (${LANE_RULE})`);
  }
  return value;
}

const MAX_ICON_LENGTH = 32;
const EMOJI_SHAPE =
  /^(?:\p{Regional_Indicator}{2}|[0-9#*]️?⃣|\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier}|[\u{E0020}-\u{E007F}])*(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})*)*)$/u;
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function checkedIcon(value: string): string {
  const ok =
    value.length <= MAX_ICON_LENGTH &&
    EMOJI_SHAPE.test(value) &&
    Array.from(GRAPHEMES.segment(value)).length === 1;
  if (!ok) throw new UsageError(`"${value.slice(0, 20)}" is not an icon: give one emoji`);
  return value;
}

export const MAX_LABELS = 16;
const MAX_LABEL_LENGTH = 32;
const LABEL_SHAPE = new RegExp(
  `^[\\p{L}\\p{N}][\\p{L}\\p{N}\\p{M} _.:/#+-]{0,${MAX_LABEL_LENGTH - 1}}$`,
  'u',
);
export const LABEL_RULE = `letters, digits, spaces and - _ . : / # +, at most ${MAX_LABEL_LENGTH} characters, starting with a letter or a digit`;

export function checkedLabels(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of values) {
    const label = raw.trim();
    if (label === '') continue;
    if (!LABEL_SHAPE.test(label)) {
      throw new UsageError(`"${label.slice(0, 40)}" is not a label: ${LABEL_RULE}`);
    }
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(label);
  }
  if (kept.length > MAX_LABELS) throw new UsageError(`a task takes at most ${MAX_LABELS} labels`);
  return kept;
}

export function checkedSize(field: SealedField, value: string, what: string): string {
  const bytes = new TextEncoder().encode(value).length;
  const limit = SEALED_LIMITS[field];
  if (bytes > limit) throw new UsageError(`${what} is too long: ${bytes} bytes, at most ${limit}`);
  return value;
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function plain(text: string): string {
  return Array.from(text, (char) => {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    return control && char !== '\n' && char !== '\t' ? '?' : char;
  }).join('');
}
