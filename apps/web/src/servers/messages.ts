import type { ConnectionState } from './connection.js';

export const reachesHttpFromHttps = (pageOrigin: string, serverUrl: string): boolean => {
  const page = new URL(pageOrigin);
  const target = new URL(serverUrl);
  return page.protocol === 'https:' && target.protocol === 'http:';
};

export const describeConnection = (
  state: ConnectionState,
  options: { readonly blockedLoopback?: boolean } = {},
): string => {
  switch (state.state) {
    case 'up':
      return 'Up.';
    case 'unreachable':
      return options.blockedLoopback === true
        ? 'Not reachable. Safari always blocks an https page from reaching a server on this computer, and Chrome blocks it until the local network permission is granted. Use the client app, or open the server at its own address.'
        : 'Not reachable.';
    case 'timeout':
      return 'The server did not answer in time.';
    case 'server-error':
      return `The server answered with an error (${state.status}).`;
    case 'too-old':
      return `Client too old. ${state.message}`;
    case 'too-new':
      return `Server too old. ${state.message}`;
    case 'signed-out':
      return 'Signed out.';
    case 'needs-pairing':
      return 'This device needs pairing.';
  }
};
