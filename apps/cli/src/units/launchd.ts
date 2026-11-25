import path from 'node:path';

import { LOCK_PROGRAMS, type WorkerUnits } from '@agent-board/contract';

import { CliError } from '../errors.js';
import {
  DISPATCH_LOCK_FILE,
  launchdFile,
  launchdLabel,
  launchdLogFile,
  type UnitName,
} from './names.js';
import { passedValues } from './recipe.js';
import type { UnitFile } from './systemd.js';

export interface LaunchdPlan {
  readonly profile: string;
  readonly recipe: WorkerUnits;
  readonly runDir: string;
  readonly logDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function xmlEscape(text: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/.test(text)) {
    throw new CliError(`cannot put a control character in a plist: ${JSON.stringify(text)}`);
  }
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

const string = (text: string): string => `<string>${xmlEscape(text)}</string>`;
const integer = (value: number): string => `<integer>${value}</integer>`;

function entry(name: string, value: string): string {
  return `\t<key>${name}</key>\n\t${value}`;
}

function plist(plan: LaunchdPlan, unit: UnitName, program: string[], extra: string[]): UnitFile {
  const log = path.join(plan.logDir, launchdLogFile(unit));
  const variables = { PATH: plan.recipe.path, ...passedValues(plan.env) };
  return {
    file: launchdFile(plan.profile, unit),
    text: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      entry('Label', string(launchdLabel(plan.profile, unit))),
      entry(
        'ProgramArguments',
        `<array>\n${program.map((arg) => `\t\t${string(arg)}`).join('\n')}\n\t</array>`,
      ),
      ...extra,
      entry('AbandonProcessGroup', '<true/>'),
      entry(
        'EnvironmentVariables',
        `<dict>\n${Object.entries(variables)
          .map(([name, value]) => `\t\t<key>${xmlEscape(name)}</key>\n\t\t${string(value)}`)
          .join('\n')}\n\t</dict>`,
      ),
      entry('StandardOutPath', string(log)),
      entry('StandardErrorPath', string(log)),
      '</dict>',
      '</plist>',
      '',
    ].join('\n'),
  };
}

export function renderLaunchd(plan: LaunchdPlan): UnitFile[] {
  const [tick, listen, watch] = plan.recipe.units;
  const lock = LOCK_PROGRAMS.darwin.split(' ');
  return [
    plist(
      plan,
      'dispatch',
      [...lock, path.join(plan.runDir, DISPATCH_LOCK_FILE), tick.program, ...tick.args],
      [entry('StartInterval', integer(tick.everySeconds)), entry('RunAtLoad', '<true/>')],
    ),
    plist(
      plan,
      'listen',
      [listen.program, ...listen.args],
      [
        entry('KeepAlive', '<true/>'),
        entry('RunAtLoad', '<true/>'),
        entry('ThrottleInterval', integer(listen.restartDelaySeconds)),
        entry('ExitTimeOut', integer(listen.stopTimeoutSeconds ?? 20)),
      ],
    ),
    plist(
      plan,
      'watch',
      [watch.program, ...watch.args],
      [
        entry('KeepAlive', '<true/>'),
        entry('RunAtLoad', '<true/>'),
        entry('ThrottleInterval', integer(watch.restartDelaySeconds)),
      ],
    ),
  ];
}

export function parseProgramArguments(plist: string): string[] | undefined {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1];
  if (array === undefined) return undefined;
  return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) =>
    (match[1] ?? '')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .replaceAll('&amp;', '&'),
  );
}
