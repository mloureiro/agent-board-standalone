import { execFile } from 'node:child_process';

import { keychainService, readKeychain, writeKeychain } from '../src/profile/keychain.js';
import { systemRuntime } from '../src/runtime.js';
import {
  createKeySetup,
  decodeDataKey,
  deriveKeys,
  open,
  seal,
  unlockKeys,
  type Binding,
} from '@agent-board/sealing';

const GOLDEN = {
  owner: 'vector-owner',
  dataKeyText: 'abk1_bCKV_XxBreX8D_SkgRQeq2h6vxPVhhYfIGrIWPU3L9Q',
  keyId: 'd5079bad2b1f434f',
  binding: { field: 'title', context: 'task:tsk_0001' } as Binding,
  plaintext: 'Fix the flaky login test',
  envelope: 'abe1.2M2TijFgkfK4IV59v9mv09JNgb8gMIB_6x8qMhZE771v7czdvdYNl_YT0XgfC3WngNQSMQ',
};

const SECURITY = '/usr/bin/security';

function run(file: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    execFile(file, args, () => undefined).on('close', (code) => {
      resolve(code ?? -1);
    });
  });
}

const keys = await deriveKeys(decodeDataKey(GOLDEN.dataKeyText), GOLDEN.owner);
const opened = await open(keys, GOLDEN.binding, GOLDEN.envelope);
const resealed = await seal(keys, GOLDEN.binding, GOLDEN.plaintext);
const reopened = await open(keys, GOLDEN.binding, resealed);

const created = await createKeySetup('spike-owner', 'correct horse battery staple', {
  m: 8192,
  t: 1,
  p: 1,
});
const unlocked = await unlockKeys('spike-owner', created.setup, {
  kind: 'passphrase',
  passphrase: 'correct horse battery staple',
});

async function keychainRoundTrip(): Promise<boolean | null> {
  if (process.platform !== 'darwin' || !process.argv.includes('--keychain')) return null;
  const rt = systemRuntime();
  const profile = `spike-${process.pid}`;
  await writeKeychain(rt, profile, 'token', 'abm_spike');
  const stored = await readKeychain(rt, profile, 'token');
  await run(SECURITY, ['delete-generic-password', '-s', keychainService(profile), '-a', 'token']);
  const gone = await readKeychain(rt, profile, 'token');
  return stored === 'abm_spike' && gone === null;
}

const keychainOk = await keychainRoundTrip();

const report = {
  runtime:
    process.versions.bun === undefined ? `node ${process.version}` : `bun ${process.versions.bun}`,
  keyIdMatches: keys.keyId === GOLDEN.keyId,
  opensGoldenEnvelope: opened === GOLDEN.plaintext,
  sealsAndOpens: reopened === GOLDEN.plaintext,
  argon2Slot: unlocked.keyId === created.setup.keyId,
  keychainRoundTrip: keychainOk,
};
console.log(JSON.stringify(report));
process.exitCode =
  report.keyIdMatches &&
  report.opensGoldenEnvelope &&
  report.sealsAndOpens &&
  report.argon2Slot &&
  report.keychainRoundTrip !== false
    ? 0
    : 1;
