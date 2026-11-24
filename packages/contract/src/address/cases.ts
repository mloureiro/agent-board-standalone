import type { AddressResult } from './rule.js';

export type AddressCase = {
  input: string;
  pinnedFingerprint?: string;
  conditional?: true;
  pinnedLanEnabled?: true;
  expect: AddressResult;
};

const FINGERPRINT = 'ab'.repeat(32);

const url = (value: string): AddressResult => ({ ok: true, url: value });
const problem = (
  value: 'invalid' | 'insecure' | 'credentials' | 'pinning-disabled',
): AddressResult => ({
  ok: false,
  problem: value,
});

export const ADDRESS_CASES: readonly AddressCase[] = [
  { input: 'https://board.example.com', expect: url('https://board.example.com/') },
  { input: '  https://board.example.com/team  ', expect: url('https://board.example.com/team') },
  { input: 'https://board.example.com:8443/', expect: url('https://board.example.com:8443/') },
  { input: 'https://[2001:db8::1]:8443', expect: url('https://[2001:db8::1]:8443/') },
  { input: 'http://localhost:4000', expect: url('http://localhost:4000/') },
  { input: 'HTTP://LOCALHOST:4000', expect: url('http://localhost:4000/') },
  { input: 'http://127.0.0.1:4000/', expect: url('http://127.0.0.1:4000/') },
  { input: 'http://[::1]:4000', expect: url('http://[::1]:4000/') },
  { input: 'http://board.example.com', expect: problem('insecure') },
  { input: 'http://localhost.example.com', expect: problem('insecure') },
  { input: 'http://localhost.', expect: problem('insecure') },
  { input: 'http://127.0.0.1.example.com', expect: problem('insecure') },
  { input: 'http://127.0.0.2:4000', expect: problem('insecure') },
  { input: 'http://192.168.1.10:4000', expect: problem('insecure') },
  { input: 'http://[::2]:4000', expect: problem('insecure') },
  { input: 'https://user:secret@board.example.com', expect: problem('credentials') },
  { input: 'https://user@board.example.com', expect: problem('credentials') },
  { input: 'http://localhost@board.example.com', expect: problem('credentials') },
  { input: '', expect: problem('invalid') },
  { input: 'board.example.com', expect: problem('invalid') },
  { input: 'https://', expect: problem('invalid') },
  { input: 'https://board example.com', expect: problem('invalid') },
  { input: 'ftp://board.example.com', expect: problem('invalid') },
  { input: 'javascript:alert(1)', expect: problem('invalid') },
  { input: 'file:///etc/hosts', expect: problem('invalid') },
  {
    input: 'https://192.168.1.10:4443',
    pinnedFingerprint: FINGERPRINT,
    expect: problem('pinning-disabled'),
  },
  {
    input: 'https://192.168.1.10:4443',
    pinnedFingerprint: FINGERPRINT,
    conditional: true,
    pinnedLanEnabled: true,
    expect: url('https://192.168.1.10:4443/'),
  },
  {
    input: 'https://10.0.0.5',
    pinnedFingerprint: FINGERPRINT,
    conditional: true,
    pinnedLanEnabled: true,
    expect: url('https://10.0.0.5/'),
  },
  {
    input: 'https://172.20.1.1',
    pinnedFingerprint: FINGERPRINT,
    conditional: true,
    pinnedLanEnabled: true,
    expect: url('https://172.20.1.1/'),
  },
  {
    input: 'https://[fd12:3456::1]:4443',
    pinnedFingerprint: FINGERPRINT,
    conditional: true,
    pinnedLanEnabled: true,
    expect: url('https://[fd12:3456::1]:4443/'),
  },
  {
    input: 'https://board.local',
    pinnedFingerprint: FINGERPRINT,
    conditional: true,
    pinnedLanEnabled: true,
    expect: url('https://board.local/'),
  },
  {
    input: 'http://192.168.1.10:4443',
    pinnedFingerprint: FINGERPRINT,
    conditional: true,
    pinnedLanEnabled: true,
    expect: problem('invalid'),
  },
  {
    input: 'https://172.32.0.1',
    pinnedFingerprint: FINGERPRINT,
    conditional: true,
    pinnedLanEnabled: true,
    expect: problem('invalid'),
  },
  {
    input: 'https://board.example.com',
    pinnedFingerprint: FINGERPRINT,
    conditional: true,
    pinnedLanEnabled: true,
    expect: problem('invalid'),
  },
  {
    input: 'https://192.168.1.10:4443',
    pinnedFingerprint: 'AB'.repeat(32),
    conditional: true,
    pinnedLanEnabled: true,
    expect: problem('invalid'),
  },
  {
    input: 'https://192.168.1.10:4443',
    pinnedFingerprint: 'ab'.repeat(31),
    conditional: true,
    pinnedLanEnabled: true,
    expect: problem('invalid'),
  },
  {
    input: 'https://user:secret@192.168.1.10',
    pinnedFingerprint: FINGERPRINT,
    conditional: true,
    pinnedLanEnabled: true,
    expect: problem('credentials'),
  },
];
