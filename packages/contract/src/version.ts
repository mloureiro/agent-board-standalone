export const PART_NAME = 'contract';
export const PART_VERSION = '1.0.0';
export const CONTRACT = 1;
export const MIN_CLIENT = { cli: 1, web: 1 } as const;
export const MIN_SERVER = 1;
export const CLIENT_KINDS = ['cli', 'web'] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];
