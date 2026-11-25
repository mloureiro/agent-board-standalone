import { describe, expect, it } from 'vitest';

import { DirectiveError, parseDirectives, splitArguments } from '../src/stubs/directives.ts';

describe('parseDirectives', () => {
  it('defaults to done when the prompt has no directive', () => {
    expect(parseDirectives('just work on the task')).toEqual([{ kind: 'done' }]);
  });

  it('parses each directive of the stub contract', () => {
    const prompt = [
      '#stub: done',
      '#stub: fail',
      '#stub: sleep 1.5',
      '#stub: ask [{"question":"Which?"}]',
      '#stub: board add --title "Follow up" --dir /work',
      '#stub: tool Read',
      '#stub: subagent',
      '#stub: usage 1200',
      '#stub: events 20001',
      '#stub: ignore-interrupt',
    ].join('\n');
    expect(parseDirectives(prompt)).toEqual([
      { kind: 'done' },
      { kind: 'fail' },
      { kind: 'sleep', seconds: 1.5 },
      { kind: 'ask', questions: [{ question: 'Which?' }] },
      { kind: 'board', args: ['add', '--title', 'Follow up', '--dir', '/work'] },
      { kind: 'tool', name: 'Read' },
      { kind: 'subagent' },
      { kind: 'usage', tokens: 1200 },
      { kind: 'events', count: 20001 },
      { kind: 'ignore-interrupt' },
    ]);
  });

  it('keeps several directives in the order they appear among other prompt text', () => {
    const prompt = 'Task title\n#stub: usage 5\nsome description\n  #stub: sleep 2\n#stub: done\n';
    expect(parseDirectives(prompt).map((directive) => directive.kind)).toEqual([
      'usage',
      'sleep',
      'done',
    ]);
  });

  it('rejects malformed JSON in ask', () => {
    expect(() => parseDirectives('#stub: ask [{"question"')).toThrow(DirectiveError);
    expect(() => parseDirectives('#stub: ask')).toThrow(DirectiveError);
  });

  it('rejects unknown directives and bad numbers', () => {
    expect(() => parseDirectives('#stub: explode')).toThrow('unknown directive: explode');
    expect(() => parseDirectives('#stub: sleep soon')).toThrow(DirectiveError);
    expect(() => parseDirectives('#stub: events 1.5')).toThrow(DirectiveError);
    expect(() => parseDirectives('#stub: usage -3')).toThrow(DirectiveError);
    expect(() => parseDirectives('#stub: tool')).toThrow(DirectiveError);
  });
});

describe('splitArguments', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(splitArguments(`add 'a b' "c d" e`)).toEqual(['add', 'a b', 'c d', 'e']);
    expect(splitArguments('x ""')).toEqual(['x', '']);
    expect(splitArguments('')).toEqual([]);
  });

  it('rejects an unterminated quote', () => {
    expect(() => splitArguments('add "oops')).toThrow(DirectiveError);
  });
});
