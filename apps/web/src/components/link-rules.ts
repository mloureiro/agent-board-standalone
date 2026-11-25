export interface LinkRule {
  readonly pattern: string;
  readonly url: string;
  readonly flags?: 'i';
}

const MAX_RULES = 50;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const isHttp = (url: string): boolean => /^https?:\/\/./i.test(url);

export function parseLinkRules(source: string): readonly LinkRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [];
  }
  const rules = record(parsed).rules;
  if (!Array.isArray(rules)) return [];
  const accepted: LinkRule[] = [];
  for (const entry of rules.slice(0, MAX_RULES)) {
    const { pattern, url, flags } = record(entry);
    if (typeof pattern !== 'string' || pattern === '' || typeof url !== 'string' || !isHttp(url)) {
      continue;
    }
    try {
      new RegExp(pattern, 'g');
    } catch {
      continue;
    }
    accepted.push(flags === 'i' ? { pattern, url, flags } : { pattern, url });
  }
  return accepted;
}

export function expandUrl(template: string, match: RegExpExecArray): string {
  return template.replace(
    /\$(\$|&|[1-9]|<([A-Za-z_][A-Za-z0-9_]*)>)/g,
    (_all, token: string, name?: string) => {
      if (token === '$') return '$';
      if (token === '&') return match[0];
      if (name !== undefined) return match.groups?.[name] ?? '';
      return match[Number(token)] ?? '';
    },
  );
}

interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

const SKIPPED = new Set(['link', 'linkReference', 'definition', 'code', 'inlineCode', 'html']);

function linkText(value: string, rule: LinkRule): Node[] {
  const pattern = new RegExp(rule.pattern, `${rule.flags ?? ''}g`);
  const nodes: Node[] = [];
  let last = 0;
  for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
    if (match[0] === '') {
      pattern.lastIndex += 1;
      continue;
    }
    const url = expandUrl(rule.url, match);
    if (!isHttp(url)) continue;
    if (match.index > last) nodes.push({ type: 'text', value: value.slice(last, match.index) });
    nodes.push({ type: 'link', url, children: [{ type: 'text', value: match[0] }] });
    last = match.index + match[0].length;
  }
  if (last === 0) return [{ type: 'text', value }];
  if (last < value.length) nodes.push({ type: 'text', value: value.slice(last) });
  return nodes;
}

function apply(parent: Node, rules: readonly LinkRule[]): void {
  if (parent.children === undefined || SKIPPED.has(parent.type)) return;
  const next: Node[] = [];
  for (const child of parent.children) {
    if (child.type !== 'text' || child.value === undefined) {
      apply(child, rules);
      next.push(child);
      continue;
    }
    let pieces: Node[] = [child];
    for (const rule of rules) {
      pieces = pieces.flatMap((piece) =>
        piece.type === 'text' && piece.value !== undefined ? linkText(piece.value, rule) : [piece],
      );
    }
    next.push(...pieces);
  }
  parent.children = next;
}

export const linkRulesPlugin = (rules: readonly LinkRule[]) => () => (tree: Node) => {
  if (rules.length > 0) apply(tree, rules);
};

export interface LinkTarget {
  readonly text: string;
  readonly url: string;
}

export function linkTargets(value: string, rules: readonly LinkRule[]): readonly LinkTarget[] {
  const targets: LinkTarget[] = [];
  for (const rule of rules) {
    const pattern = new RegExp(rule.pattern, `${rule.flags ?? ''}g`);
    for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
      if (match[0] === '') {
        pattern.lastIndex += 1;
        continue;
      }
      const url = expandUrl(rule.url, match);
      if (isHttp(url)) targets.push({ text: match[0], url });
    }
  }
  return targets;
}
