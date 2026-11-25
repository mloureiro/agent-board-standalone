export const SERVER_LIST_KEY = 'ab:servers';
export const DEVICE_PREFIX = 'ab:device:';
export const KEYS_STORE = 'keys';

export const serverPrefix = (serverId: string): string => `ab:${serverId}:`;
export const serverDatabaseName = (serverId: string): string => `agent-board:${serverId}`;
