import path from 'node:path';

import type { WorkerUnits } from '@rumo/contract';

import { CliError } from '../errors.js';
import { DISPATCH_LOCK_FILE, systemdService, systemdTimer, type UnitName } from './names.js';
import { passedValues } from './recipe.js';

export interface UnitFile {
  readonly file: string;
  readonly text: string;
}

export interface SystemdPlan {
  readonly profile: string;
  readonly recipe: WorkerUnits;
  readonly runDir: string;
  readonly flock: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function quoteExecArg(arg: string): string {
  if (/[\n\r]/.test(arg)) throw new CliError(`cannot put a line break in a unit file: ${arg}`);
  const escaped = arg.replaceAll('%', '%%').replaceAll('$', '$$$$');
  if (/^[A-Za-z0-9_@:,./=+-]+$/.test(escaped.replaceAll('%%', '').replaceAll('$$', ''))) {
    return escaped;
  }
  return `"${escaped.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function environmentLine(name: string, value: string): string {
  if (/[\n\r]/.test(value)) throw new CliError(`${name} holds a line break`);
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  return `Environment="${name}=${escaped}"`;
}

function environmentOf(plan: SystemdPlan): string {
  return [
    environmentLine('PATH', plan.recipe.path),
    ...Object.entries(passedValues(plan.env)).map(([name, value]) => environmentLine(name, value)),
  ].join('\n');
}

function command(program: string, args: readonly string[]): string {
  return [program, ...args].map(quoteExecArg).join(' ');
}

export function renderSystemd(plan: SystemdPlan): UnitFile[] {
  const [tick, listen, watch] = plan.recipe.units;
  const environment = environmentOf(plan);
  const lock = path.join(plan.runDir, DISPATCH_LOCK_FILE);
  const label = (unit: UnitName): string => `rumo ${plan.profile} ${unit}`;
  return [
    {
      file: systemdService(plan.profile, 'dispatch'),
      text: `[Unit]
Description=${label('dispatch')}: one tick

[Service]
Type=oneshot
${environment}
ExecStart=${[
        quoteExecArg(plan.flock),
        '-n',
        '-E',
        String(tick.lockHeldExitCode),
        quoteExecArg(lock),
        command(tick.program, tick.args),
      ].join(' ')}
SuccessExitStatus=${tick.lockHeldExitCode}
TimeoutStartSec=${tick.limitSeconds + tick.graceSeconds}
`,
    },
    {
      file: systemdTimer(plan.profile),
      text: `[Unit]
Description=${label('dispatch')}: a tick every ${tick.everySeconds} seconds

[Timer]
OnBootSec=${tick.everySeconds}s
OnUnitActiveSec=${tick.everySeconds}s
AccuracySec=${tick.graceSeconds}s

[Install]
WantedBy=timers.target
`,
    },
    {
      file: systemdService(plan.profile, 'listen'),
      text: `[Unit]
Description=${label('listen')}: dispatch as soon as the board says tasks changed
StartLimitIntervalSec=0

[Service]
Type=simple
${environment}
ExecStart=${command(listen.program, listen.args)}
Restart=always
RestartSec=${listen.restartDelaySeconds}
KillMode=mixed
TimeoutStopSec=${listen.stopTimeoutSeconds ?? 90}

[Install]
WantedBy=default.target
`,
    },
    {
      file: systemdService(plan.profile, 'watch'),
      text: `[Unit]
Description=${label('watch')}: runs the watches of this machine's tasks
StartLimitIntervalSec=0

[Service]
Type=simple
${environment}
ExecStart=${command(watch.program, watch.args)}
Restart=always
RestartSec=${watch.restartDelaySeconds}

[Install]
WantedBy=default.target
`,
    },
  ];
}
