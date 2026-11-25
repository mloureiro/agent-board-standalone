export interface LinkRuleDraft {
  readonly pattern: string;
  readonly url: string;
  readonly ignoreCase: boolean;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const parseLinkDrafts = (text: string | null): readonly LinkRuleDraft[] => {
  if (text === null || text.trim() === '') return [];
  const rules = record(JSON.parse(text)).rules;
  if (!Array.isArray(rules)) return [];
  return rules.map((entry) => {
    const { pattern, url, flags } = record(entry);
    return {
      pattern: typeof pattern === 'string' ? pattern : '',
      url: typeof url === 'string' ? url : '',
      ignoreCase: flags === 'i',
    };
  });
};

export const serializeLinkDrafts = (rules: readonly LinkRuleDraft[]): string =>
  JSON.stringify({
    version: 1,
    rules: rules.map((rule) => ({
      pattern: rule.pattern,
      url: rule.url,
      ...(rule.ignoreCase ? { flags: 'i' } : {}),
    })),
  });

export const patternProblem = (pattern: string): string | null => {
  if (pattern === '') return 'Enter a pattern.';
  try {
    new RegExp(pattern, 'g');
    return null;
  } catch {
    return 'The pattern is not a valid regular expression.';
  }
};

export const linkProblem = (rule: LinkRuleDraft): string | null =>
  patternProblem(rule.pattern) ??
  (/^https?:\/\/./i.test(rule.url) ? null : 'The URL must start with http:// or https://.');
