export const UNIT_NAMES = ['dispatch', 'listen', 'watch'] as const;
export type UnitName = (typeof UNIT_NAMES)[number];

export function isUnitName(value: string): value is UnitName {
  return (UNIT_NAMES as readonly string[]).includes(value);
}

export const launchdLabel = (profile: string, unit: UnitName): string =>
  `agent-board.${profile}.${unit}`;

export const launchdFile = (profile: string, unit: UnitName): string =>
  `${launchdLabel(profile, unit)}.plist`;

export const systemdBase = (profile: string, unit: UnitName): string =>
  `agent-board-${profile}-${unit}`;

export const systemdService = (profile: string, unit: UnitName): string =>
  `${systemdBase(profile, unit)}.service`;

export const systemdTimer = (profile: string): string =>
  `${systemdBase(profile, 'dispatch')}.timer`;

export function systemdFiles(profile: string): string[] {
  return [
    systemdService(profile, 'dispatch'),
    systemdTimer(profile),
    systemdService(profile, 'listen'),
    systemdService(profile, 'watch'),
  ];
}

export function systemdEnabled(profile: string): string[] {
  return [
    systemdTimer(profile),
    systemdService(profile, 'listen'),
    systemdService(profile, 'watch'),
  ];
}

export function restartedSystemdUnit(profile: string, unit: UnitName): string {
  return unit === 'dispatch' ? systemdTimer(profile) : systemdService(profile, unit);
}

export const REMOVED_INTAKE_FILES = ['agent-board-intake.service', 'agent-board-intake.timer'];

export const DISPATCH_LOCK_FILE = 'dispatch.lock';

export const launchdLogFile = (unit: UnitName): string => `launchd.${unit}.log`;
