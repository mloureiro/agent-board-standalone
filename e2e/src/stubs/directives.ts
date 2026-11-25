export type Directive =
  | { readonly kind: 'done' }
  | { readonly kind: 'fail' }
  | { readonly kind: 'sleep'; readonly seconds: number }
  | { readonly kind: 'ask'; readonly questions: unknown }
  | { readonly kind: 'board'; readonly args: readonly string[] }
  | { readonly kind: 'tool'; readonly name: string }
  | { readonly kind: 'subagent' }
  | { readonly kind: 'usage'; readonly tokens: number }
  | { readonly kind: 'events'; readonly count: number; readonly bytes?: number }
  | { readonly kind: 'ignore-interrupt' };

export class DirectiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectiveError';
  }
}

const DIRECTIVE_LINE = /^\s*#stub:\s*(\S+)(?:\s+(.*?))?\s*$/;

export function splitArguments(text: string): string[] {
  const args: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote !== null) throw new DirectiveError(`unterminated quote in: ${text}`);
  if (started) args.push(current);
  return args;
}

function count(name: string, value: string | undefined, allowFraction = false): number {
  const parsed = value === undefined || value === '' ? Number.NaN : Number(value);
  const valid = allowFraction ? parsed >= 0 : Number.isInteger(parsed) && parsed >= 0;
  if (!Number.isFinite(parsed) || !valid) {
    throw new DirectiveError(`#stub: ${name} needs a non-negative number, got "${value ?? ''}"`);
  }
  return parsed;
}

function parseLine(name: string, rest: string | undefined): Directive {
  switch (name) {
    case 'done':
      return { kind: 'done' };
    case 'fail':
      return { kind: 'fail' };
    case 'subagent':
      return { kind: 'subagent' };
    case 'ignore-interrupt':
      return { kind: 'ignore-interrupt' };
    case 'sleep':
      return { kind: 'sleep', seconds: count(name, rest, true) };
    case 'usage':
      return { kind: 'usage', tokens: count(name, rest) };
    case 'events': {
      const [amount, size] = (rest ?? '').split(/\s+/);
      return size === undefined
        ? { kind: 'events', count: count(name, amount) }
        : { kind: 'events', count: count(name, amount), bytes: count(name, size) };
    }
    case 'tool':
      if (rest === undefined || rest === '') throw new DirectiveError('#stub: tool needs a name');
      return { kind: 'tool', name: rest };
    case 'board':
      return { kind: 'board', args: splitArguments(rest ?? '') };
    case 'ask':
      try {
        return { kind: 'ask', questions: JSON.parse(rest ?? '') as unknown };
      } catch {
        throw new DirectiveError(`#stub: ask needs a JSON value, got "${rest ?? ''}"`);
      }
    default:
      throw new DirectiveError(`unknown directive: ${name}`);
  }
}

export function parseDirectives(prompt: string): Directive[] {
  const directives: Directive[] = [];
  for (const line of prompt.split('\n')) {
    const match = DIRECTIVE_LINE.exec(line);
    if (match?.[1] !== undefined) directives.push(parseLine(match[1], match[2]));
  }
  return directives.length === 0 ? [{ kind: 'done' }] : directives;
}
