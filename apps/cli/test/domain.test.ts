import { execFileSync } from 'node:child_process';
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { formatAnswers, formatQuestions, parseQuestions } from '../src/domain/questions.js';
import {
  checkedIcon,
  checkedLabels,
  checkedPrUrl,
  parseStatus,
  prUrlIn,
} from '../src/domain/rules.js';
import { formatDuration, parseDuration, parseStart, parseWhen } from '../src/domain/time.js';
import { UsageError } from '../src/errors.js';
import { readNoteFile } from '../src/input/note-file.js';
import { tmpDir, tmpFile } from './support/files.js';

describe('durations and times', () => {
  it('parses and formats durations, largest unit first', () => {
    expect(parseDuration('1h30m')).toBe(90 * 60_000);
    expect(parseDuration('1w 2d')).toBe(9 * 86_400_000);
    expect(parseDuration('30s', true)).toBe(30_000);
    expect(formatDuration(90 * 60_000)).toBe('1h30m');
    expect(formatDuration(30_000)).toBe('30s');
    for (const bad of ['', '0m', '2x', '30s', 'h'])
      expect(() => parseDuration(bad)).toThrow(UsageError);
  });

  it('parses a time with an offset, local, a date and a time of day, and refuses the past and impossible dates', () => {
    const now = new Date(2026, 5, 1, 10, 0, 0);
    expect(parseWhen('2027-01-01T12:00:00Z', now).toISOString()).toBe('2027-01-01T12:00:00.000Z');
    expect(parseWhen('2027-01-01T12:00', now).getHours()).toBe(12);
    expect(parseWhen('2027-01-01', now).getHours()).toBe(0);
    expect(parseWhen('09:30', now).getDate()).toBe(2);
    expect(parseWhen('11:30', now).getDate()).toBe(1);
    expect(() => parseWhen('2020-01-01', now)).toThrow('in the past');
    expect(() => parseWhen('2027-02-30', now)).toThrow('is not a time');
    expect(() => parseWhen('2027-02-30T10:00:00Z', now)).toThrow('is not a time');
    expect(() => parseWhen('25:00', now)).toThrow('is not a time');
  });

  it('starts from --in or --at', () => {
    const now = new Date(2026, 5, 1, 10, 0, 0);
    expect(parseStart({ in: '2h' }, now)?.getTime()).toBe(now.getTime() + 2 * 3_600_000);
    expect(parseStart({}, now)).toBeUndefined();
  });
});

describe('questions', () => {
  const option = (label: string) => ({ label, description: '' });
  const question = {
    header: 'H',
    question: 'Q?',
    multiSelect: false,
    options: [option('a'), option('b')],
  };

  it('accepts the list or the object, and formats them for the thread', () => {
    const parsed = parseQuestions({ questions: [question] });
    expect(parseQuestions([question])).toEqual(parsed);
    expect(formatQuestions(parsed)).toBe('- **H**: Q?\n  - a\n  - b');
    expect(formatAnswers(parsed, [{ picks: ['a'], other: 'and more' }])).toBe(
      '- H: Q? → a; and more',
    );
    expect(formatAnswers(undefined, [{ picks: [], other: null }])).toBe('- Question 1 → (none)');
  });

  it('refuses duplicates, two recommendations, a long header and too few options', () => {
    const bad = (change: object) => () => parseQuestions([{ ...question, ...change }]);
    expect(bad({ options: [option('a'), option('a')] })).toThrow('different labels');
    expect(
      bad({
        options: [
          { ...option('a'), recommended: true },
          { ...option('b'), recommended: true },
        ],
      }),
    ).toThrow('one option at most');
    expect(bad({ header: 'x'.repeat(17) })).toThrow('at most 16');
    expect(bad({ options: [option('a')] })).toThrow('2 to 4');
    expect(bad({ multiSelect: 'yes' })).toThrow('boolean');
  });
});

describe('rules', () => {
  it('normalises a status name and refuses an unknown one', () => {
    expect(parseStatus(' Needs me ')).toBe('needs-me');
    expect(() => parseStatus('later')).toThrow(UsageError);
  });

  it('knows a GitHub pull request URL and finds it in the first line of a prompt', () => {
    const url = 'https://github.com/a/b/pull/2';
    expect(checkedPrUrl(url)).toBe(url);
    expect(() => checkedPrUrl(`${url}/files`)).toThrow(UsageError);
    expect(prUrlIn(`/review-pr ${url} --auto\nsee https://github.com/a/b/pull/3`)).toBe(url);
    expect(prUrlIn(`Find out X\n${url}`)).toBeUndefined();
  });

  it('accepts one emoji only and checks labels', () => {
    expect(checkedIcon('🚀')).toBe('🚀');
    expect(checkedIcon('👨‍👩‍👧')).toBe('👨‍👩‍👧');
    for (const bad of ['', 'a', '🚀🚀', 'x🚀']) expect(() => checkedIcon(bad)).toThrow(UsageError);
    expect(checkedLabels([' bug ', 'Bug', 'needs review', ''])).toEqual(['bug', 'needs review']);
    expect(() => checkedLabels(['-bad'])).toThrow(UsageError);
    expect(() => checkedLabels(Array.from({ length: 17 }, (_, index) => `l${index}`))).toThrow(
      'at most 16',
    );
  });
});

describe('the files a command reads', () => {
  it('reads a regular file in /tmp trimmed', () => {
    expect(readNoteFile(tmpFile('  text \n'))).toBe('text');
  });

  it('refuses a file outside /tmp, a symlink, a hard link, a directory and a file over 1 MiB', () => {
    const outside = mkdtempSync(path.join(process.cwd(), '.outside-'));
    try {
      const elsewhere = path.join(outside, 'note.txt');
      writeFileSync(elsewhere, 'x');
      expect(() => readNoteFile(elsewhere)).toThrow('inside /tmp/');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }

    const directory = tmpDir();
    const file = path.join(directory, 'real.txt');
    writeFileSync(file, 'secret');
    symlinkSync(file, path.join(directory, 'link.txt'));
    expect(() => readNoteFile(path.join(directory, 'link.txt'))).toThrow(UsageError);
    linkSync(file, path.join(directory, 'hard.txt'));
    expect(() => readNoteFile(file)).toThrow('hard link');
    expect(() => readNoteFile(directory)).toThrow(UsageError);
    expect(() => readNoteFile(tmpFile('x'.repeat(1024 * 1024 + 1)))).toThrow('1 MiB');
    expect(() => readNoteFile('/tmp/board-cli-test-missing/none')).toThrow('cannot read');
  });

  it('refuses a named pipe without waiting for a writer', () => {
    const fifo = path.join(tmpDir(), 'pipe');
    execFileSync('mkfifo', [fifo]);
    expect(() => readNoteFile(fifo)).toThrow('regular file');
  });
});
