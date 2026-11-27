import {
  createKeySetup,
  decodeDataKey,
  deriveKeys,
  open,
  seal,
  unlockKeys,
  type Binding,
} from '@rumo/sealing';

const GOLDEN = {
  owner: 'vector-owner',
  dataKeyText: 'abk1_bCKV_XxBreX8D_SkgRQeq2h6vxPVhhYfIGrIWPU3L9Q',
  keyId: 'd5079bad2b1f434f',
  binding: { field: 'title', context: 'task:tsk_0001' } as Binding,
  plaintext: 'Fix the flaky login test',
  envelope: 'abe1.2M2TijFgkfK4IV59v9mv09JNgb8gMIB_6x8qMhZE771v7czdvdYNl_YT0XgfC3WngNQSMQ',
};

export interface SelfTestReport {
  readonly runtime: string;
  readonly keyIdMatches: boolean;
  readonly opensGoldenEnvelope: boolean;
  readonly sealsAndOpens: boolean;
  readonly passphraseSlot: boolean;
}

export async function runSelfTest(): Promise<SelfTestReport> {
  const keys = await deriveKeys(decodeDataKey(GOLDEN.dataKeyText), GOLDEN.owner);
  const opened = await open(keys, GOLDEN.binding, GOLDEN.envelope);
  const resealed = await seal(keys, GOLDEN.binding, GOLDEN.plaintext);
  const reopened = await open(keys, GOLDEN.binding, resealed);
  const created = await createKeySetup('selftest-owner', 'correct horse battery staple', {
    m: 8192,
    t: 1,
    p: 1,
  });
  const unlocked = await unlockKeys('selftest-owner', created.setup, {
    kind: 'passphrase',
    passphrase: 'correct horse battery staple',
  });
  return {
    runtime:
      process.versions.bun === undefined
        ? `node ${process.version}`
        : `bun ${process.versions.bun}`,
    keyIdMatches: keys.keyId === GOLDEN.keyId,
    opensGoldenEnvelope: opened === GOLDEN.plaintext,
    sealsAndOpens: reopened === GOLDEN.plaintext,
    passphraseSlot: unlocked.keyId === created.setup.keyId,
  };
}

export function selfTestPassed(report: SelfTestReport): boolean {
  return (
    report.keyIdMatches &&
    report.opensGoldenEnvelope &&
    report.sealsAndOpens &&
    report.passphraseSlot
  );
}
