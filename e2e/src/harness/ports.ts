import net from 'node:net';

export const LOOPBACK = '127.0.0.1';

export function freePort(host: string = LOOPBACK): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not read the allocated port'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}
