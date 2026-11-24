export const FEATURE_LABELS = {
  projects: 'projects',
  directories: 'directories',
  'legacy-dirs': 'legacy directory conversion',
  'client-tokens': 'client tokens',
  'request-signature': 'request signatures',
  pairing: 'device pairing',
  'machine-grant': 'machine grants',
  'settings-document': 'the settings document',
  attention: 'attention notices',
  devices: 'devices',
  'board-export': 'board export',
  schedules: 'schedules',
  feeds: 'feeds',
  transcripts: 'transcripts',
  'shared-agents': 'shared agents',
  'title-rules': 'title rules',
  'link-rules': 'link rules',
  forks: 'forks',
  watches: 'watches',
  'run-inbox': 'the run inbox',
} as const;

export type Feature = keyof typeof FEATURE_LABELS;

export const FEATURES = Object.freeze(
  Object.keys(FEATURE_LABELS) as Feature[],
) as readonly Feature[];

export const isFeature = (value: unknown): value is Feature =>
  typeof value === 'string' && (FEATURES as readonly string[]).includes(value);
