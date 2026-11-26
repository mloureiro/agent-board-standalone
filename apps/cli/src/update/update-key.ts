declare const __BOARD_UPDATE_KEY__: string | undefined;

export const UPDATE_KEY_GLOBAL = '__BOARD_UPDATE_KEY__';

export const EMBEDDED_UPDATE_KEY: string | null =
  typeof __BOARD_UPDATE_KEY__ === 'string' ? __BOARD_UPDATE_KEY__ : null;
