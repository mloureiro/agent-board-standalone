import { expandUrl } from '../../components/link-rules.js';
import { patternProblem } from './link-rules-model.js';

export interface TitleRuleDraft {
  readonly pattern: string;
  readonly ignoreCase: boolean;
  readonly title: string;
  readonly icon: string;
  readonly labels: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const labelList = (value: unknown): string =>
  Array.isArray(value) ? value.filter((entry) => typeof entry === 'string').join(', ') : '';

export const splitLabels = (labels: string): string[] =>
  labels
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label !== '');

export const parseTitleDrafts = (source: string | null): readonly TitleRuleDraft[] => {
  if (source === null || source.trim() === '') return [];
  const rules = record(JSON.parse(source)).rules;
  if (!Array.isArray(rules)) return [];
  return rules.map((entry) => {
    const rule = record(entry);
    return {
      pattern: text(rule.pattern),
      ignoreCase: rule.flags === 'i',
      title: text(rule.title),
      icon: text(rule.icon),
      labels: labelList(rule.labels),
    };
  });
};

export const serializeTitleDrafts = (rules: readonly TitleRuleDraft[]): string =>
  JSON.stringify({
    version: 1,
    rules: rules.map((rule) => ({
      pattern: rule.pattern,
      ...(rule.ignoreCase ? { flags: 'i' } : {}),
      ...(rule.title === '' ? {} : { title: rule.title }),
      ...(rule.icon === '' ? {} : { icon: rule.icon }),
      ...(splitLabels(rule.labels).length === 0 ? {} : { labels: splitLabels(rule.labels) }),
    })),
  });

export const titleProblem = (rule: TitleRuleDraft): string | null =>
  patternProblem(rule.pattern) ??
  (rule.title === '' && rule.icon === '' && splitLabels(rule.labels).length === 0
    ? 'Set a title, an icon or labels.'
    : null);

export interface TitleOutcome {
  readonly title: string | null;
  readonly icon: string | null;
  readonly labels: readonly string[];
}

export const applyTitleRules = (
  value: string,
  rules: readonly TitleRuleDraft[],
): TitleOutcome | null => {
  for (const rule of rules) {
    if (titleProblem(rule) !== null) continue;
    const match = new RegExp(rule.pattern, rule.ignoreCase ? 'i' : '').exec(value);
    if (match === null) continue;
    return {
      title: rule.title === '' ? null : expandUrl(rule.title, match),
      icon: rule.icon === '' ? null : rule.icon,
      labels: splitLabels(rule.labels),
    };
  }
  return null;
};
