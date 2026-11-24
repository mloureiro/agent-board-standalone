import type { HandoverResult } from './handover.js';

export type HandoverParseCase = { link: string; expect: HandoverResult };
export type HandoverBuildCase = { url: string; link: string };
export type HandoverCase = HandoverParseCase | HandoverBuildCase;

const ok = (url: string): HandoverResult => ({ ok: true, url });
const problem = (
  value: 'not-handover' | 'unknown-version' | 'bad-url' | 'not-loopback' | 'credentials',
): HandoverResult => ({
  ok: false,
  problem: value,
});

export const HANDOVER_CASES: readonly HandoverCase[] = [
  {
    link: 'agentboard://open?v=1&url=http%3A%2F%2Flocalhost%3A4000%2F',
    expect: ok('http://localhost:4000/'),
  },
  {
    link: 'agentboard://open?v=1&url=https%3A%2F%2F127.0.0.1%3A4000%2F',
    expect: ok('https://127.0.0.1:4000/'),
  },
  {
    link: 'agentboard://open?v=1&url=http%3A%2F%2F%5B%3A%3A1%5D%3A4000%2F',
    expect: ok('http://[::1]:4000/'),
  },
  {
    link: 'agentboard://open?v=1&url=http%3A%2F%2Flocalhost%3A4000%2F&extra=1',
    expect: ok('http://localhost:4000/'),
  },
  {
    link: 'agentboard://open?v=1&url=http%3A%2F%2Fuser%3Asecret%40localhost%3A4000%2F',
    expect: problem('credentials'),
  },
  {
    link: 'agentboard://open?v=1&url=http%3A%2F%2F192.168.1.10%3A4000%2F',
    expect: problem('not-loopback'),
  },
  {
    link: 'agentboard://open?v=1&url=https%3A%2F%2Fboard.example.com%2F',
    expect: problem('not-loopback'),
  },
  {
    link: 'agentboard://open?v=2&url=http%3A%2F%2Flocalhost%3A4000%2F',
    expect: problem('unknown-version'),
  },
  {
    link: 'agentboard://open?url=http%3A%2F%2Flocalhost%3A4000%2F',
    expect: problem('unknown-version'),
  },
  { link: 'agentboard://open?v=1', expect: problem('bad-url') },
  { link: 'agentboard://open?v=1&url=not-a-url', expect: problem('bad-url') },
  {
    link: 'https://open?v=1&url=http%3A%2F%2Flocalhost%3A4000%2F',
    expect: problem('not-handover'),
  },
  {
    link: 'agentboard://open/?v=1&url=http%3A%2F%2Flocalhost%3A4000%2F',
    expect: problem('not-handover'),
  },
  { link: 'not a link', expect: problem('not-handover') },
  {
    url: 'http://localhost:4000/',
    link: 'agentboard://open?v=1&url=http%3A%2F%2Flocalhost%3A4000%2F',
  },
  {
    url: 'https://127.0.0.1:4000/',
    link: 'agentboard://open?v=1&url=https%3A%2F%2F127.0.0.1%3A4000%2F',
  },
  {
    url: 'http://[::1]:4000/',
    link: 'agentboard://open?v=1&url=http%3A%2F%2F%5B%3A%3A1%5D%3A4000%2F',
  },
];
