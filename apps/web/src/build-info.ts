declare const __WEB_COMMIT__: string | undefined;

export const BUILD_COMMIT: string | null =
  typeof __WEB_COMMIT__ === 'string' && __WEB_COMMIT__ !== '' ? __WEB_COMMIT__ : null;
