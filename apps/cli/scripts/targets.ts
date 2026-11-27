export const RELEASE_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-arm64'] as const;

export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

export function hostTarget(platform: string, arch: string): ReleaseTarget | null {
  const target = `${platform}-${arch}`;
  return (RELEASE_TARGETS as readonly string[]).includes(target) ? (target as ReleaseTarget) : null;
}

export const assetFile = (target: ReleaseTarget): string => `rumo-${target}`;
