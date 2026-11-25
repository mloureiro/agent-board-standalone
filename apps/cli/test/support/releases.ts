import { createHash } from 'node:crypto';

import { startServer, type FakeServer } from './server.js';

export interface FakeRelease {
  readonly version: string;
  readonly target?: string;
  readonly content?: string;
  readonly checksum?: string;
  readonly noChecksums?: boolean;
  readonly prerelease?: boolean;
  readonly draft?: boolean;
  readonly tagPrefix?: string;
}

export interface ReleaseServer {
  readonly server: FakeServer;
  readonly listUrl: string;
}

export const sha256 = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

export async function startReleaseServer(releases: readonly FakeRelease[]): Promise<ReleaseServer> {
  let base = '';
  const contentOf = (release: FakeRelease): string =>
    release.content ?? `binary of ${release.version}`;
  const tagOf = (release: FakeRelease): string =>
    `${release.tagPrefix ?? 'cli-v'}${release.version}`;
  const server = await startServer((request) => {
    if (request.path.startsWith('/releases')) {
      return {
        body: releases.map((release) => {
          const target = release.target ?? 'linux-x64';
          return {
            tag_name: tagOf(release),
            draft: release.draft === true,
            prerelease: release.prerelease === true,
            assets: [
              {
                name: `board-${target}`,
                browser_download_url: `${base}/assets/${tagOf(release)}/board-${target}`,
              },
              ...(release.noChecksums === true
                ? []
                : [
                    {
                      name: 'SHA256SUMS',
                      browser_download_url: `${base}/assets/${tagOf(release)}/SHA256SUMS`,
                    },
                  ]),
            ],
          };
        }),
      };
    }
    const [, , tag, name] = request.path.split('/');
    const release = releases.find((entry) => tagOf(entry) === tag);
    if (release === undefined) return undefined;
    const target = release.target ?? 'linux-x64';
    if (name === `board-${target}`) {
      return { stream: (response) => response.end(contentOf(release)) };
    }
    if (name === 'SHA256SUMS' && release.noChecksums !== true) {
      const sum = release.checksum ?? sha256(contentOf(release));
      return { stream: (response) => response.end(`${sum}  board-${target}\n`) };
    }
    return undefined;
  });
  base = server.url;
  return { server, listUrl: `${server.url}/releases` };
}
