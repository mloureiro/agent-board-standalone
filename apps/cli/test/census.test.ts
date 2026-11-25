import { describe, expect, it } from 'vitest';

import { buildProgram, runCli } from '../src/commands/program.js';
import { EXIT } from '../src/errors.js';
import { SETTING_KEYS } from '../src/commands/tasks/settings.js';
import { readCensus } from './support/census.js';
import { testRuntime } from './support/runtime.js';

const BUILT = [
  'CMD-01',
  'CMD-02',
  'CMD-03',
  'CMD-04',
  'CMD-05',
  'CMD-06',
  'CMD-07',
  'CMD-08',
  'CMD-09',
  'CMD-10',
  'CMD-11',
  'CMD-12',
  'CMD-13',
  'CMD-14',
  'CMD-15',
  'CMD-16',
  'CMD-17',
  'CMD-18',
  'CMD-19',
  'CMD-21',
  'CMD-22',
  'CMD-24',
  'CMD-26',
] as const;

const DROPPED = ['CMD-38'] as const;

const BUILT_IN_FLAGS = new Set(['--help']);

const census = readCensus();
const test_ = testRuntime();
const program = buildProgram(test_.rt);

function commandFor(id: string) {
  const entry = census.commands.find((command) => command.id === id);
  if (entry === undefined) throw new Error(`${id} is not in the census`);
  return entry.name === 'board'
    ? program
    : program.commands.find((command) => command.name() === entry.name);
}

describe('the census of cli-review section 1', () => {
  it('[cli-012] reads the whole census table', () => {
    expect(census.commands.length).toBeGreaterThanOrEqual(45);
    expect(census.options.length).toBeGreaterThan(150);
    for (const id of [...BUILT, ...DROPPED]) {
      expect(census.commands.map((command) => command.id)).toContain(id);
    }
  });

  it.each(BUILT.filter((id) => id !== 'CMD-02'))(
    '[cli-012] %s is a command of the tree with every option of the census',
    (id) => {
      const command = commandFor(id);
      expect(command, `${id} is missing from the commander tree`).toBeDefined();
      const flags = new Set(
        (command?.options ?? []).flatMap((option) => (option.long ? [option.long] : [])),
      );
      for (const option of census.options.filter((entry) => entry.command === id)) {
        for (const flag of option.flags.filter((candidate) => !BUILT_IN_FLAGS.has(candidate))) {
          expect(flags.has(flag), `${option.id} ${flag} on ${id}`).toBe(true);
        }
      }
    },
  );

  it('[cli-012] board help prints the usage of a command', async () => {
    expect(await runCli(['help', 'tasks'], test_.rt)).toBe(EXIT.ok);
    expect(test_.captured.stdout).toContain('Usage: board tasks');
  });

  it('[cli-012] task accepts every key of the census', () => {
    const wanted = census.keys
      .filter((entry) => entry.command === 'CMD-17')
      .map((entry) => entry.key);
    expect(wanted).toHaveLength(9);
    for (const key of wanted) expect(SETTING_KEYS as readonly string[]).toContain(key);
  });

  it('[cli-012] every census exit code exists', () => {
    expect(Object.values(EXIT)).toEqual(expect.arrayContaining([0, 1, 2, 3, 75, 124]));
  });

  it('[cli-012] registers none of the commands the census drops', () => {
    for (const id of DROPPED) {
      const dropped = census.commands.find((command) => command.id === id);
      const name = dropped?.name.split(/\s+/)[1];
      expect(program.commands.map((command) => command.name())).not.toContain(name);
    }
  });

  it('[cli-012] no command of the tree is missing from the census except the ones this CLI adds', () => {
    const known = new Set(census.commands.map((command) => command.name.split(/\s+/)[0]));
    const added = new Set([
      'version',
      'answer',
      'dismiss',
      'reply',
      'send',
      'stop',
      'take-back',
      'rerun',
      'close',
      'reopen',
      'fork',
      'transcript',
      'machines',
      'projects',
    ]);
    for (const command of program.commands) {
      expect(known.has(command.name()) || added.has(command.name()), command.name()).toBe(true);
    }
  });
});
