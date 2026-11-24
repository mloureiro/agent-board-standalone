import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Bytes = Uint8Array;
interface Binding {
  field: string;
  context: string;
}
interface Keys {
  keyId: string;
}
interface Slot {
  kind: string;
  [key: string]: Json;
}
interface KeySetup {
  keyId: string;
  slots: Slot[];
}
interface Kdf {
  m: number;
  t: number;
  p: number;
}
type Secret =
  { kind: 'passphrase'; passphrase: string } | { kind: 'recovery'; recoveryKey: string };
type Row = Record<string, Json>;

interface Crypto {
  deriveKeys(dataKey: Bytes, owner: string, options: { index: boolean }): Promise<Keys>;
  seal(keys: Keys, field: string, context: string, plaintext: string): Promise<string>;
  open(keys: Keys, field: string, context: string, envelope: string): Promise<string>;
  blindIndex(keys: Keys, value: string): Promise<string>;
  encodeDataKey(key: Bytes): string;
  generateDataKey(): Bytes;
  isEnvelope(value: string): boolean;
  isBlindIndex(value: string): boolean;
  toBase64Url(bytes: Bytes): string;
  fromBase64Url(text: string): Bytes | null;
}
interface Unlocker {
  openDataKey(slots: Slot[], secret: Secret): Promise<Bytes>;
  createKeySetup(options: {
    owner: string;
    passphrase: string;
    kdf: Kdf;
  }): Promise<{ setup: KeySetup; keys: Keys; recoveryKey: string }>;
  unlockKeys(options: { owner: string; stored: KeySetup; secret: Secret }): Promise<Keys>;
  replacePassphrase(options: {
    owner: string;
    stored: KeySetup;
    secret: Secret;
    newPassphrase: string;
    kdf: Kdf;
  }): Promise<{ keys: Keys; slots: Slot[] }>;
}
interface Reference {
  crypto: Crypto;
  unlocker: Unlocker;
  formatRecoveryKey(key: Bytes): Promise<string>;
  parseRecoveryKey(text: string): Promise<Bytes>;
  hashToken(token: string): string;
  sealing: Record<string, (...args: never[]) => unknown>;
}

const SOURCE = 'reference board 011f7be';
const GENERATOR = 'scripts/generate-vectors.mts';
const PASSPHRASE = 'correct horse battery staple';
const OWNERS = ['vector-owner', 'vector-owner-2'] as const;
const PRODUCTION_KDF: Kdf = { m: 65_536, t: 3, p: 1 };
const MINIMUM_KDF: Kdf = { m: 8192, t: 1, p: 1 };
const SEED = 'agent-board-vectors';
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);

function installSeededRandom(): () => void {
  let counter = 0;
  let pool = Buffer.alloc(0);
  const original = Object.getOwnPropertyDescriptor(globalThis.crypto, 'getRandomValues');
  const draw = (target: ArrayBufferView): ArrayBufferView => {
    const out = new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
    let filled = 0;
    while (filled < out.length) {
      if (pool.length === 0) {
        const index = Buffer.alloc(4);
        index.writeUInt32BE(counter++);
        pool = createHash('sha256').update(SEED).update(index).digest();
      }
      const take = Math.min(pool.length, out.length - filled);
      out.set(pool.subarray(0, take), filled);
      pool = pool.subarray(take);
      filled += take;
    }
    return target;
  };
  Object.defineProperty(globalThis.crypto, 'getRandomValues', {
    value: draw,
    configurable: true,
    writable: true,
  });
  return () => {
    if (original) Object.defineProperty(globalThis.crypto, 'getRandomValues', original);
    else delete (globalThis.crypto as unknown as Record<string, unknown>)['getRandomValues'];
  };
}

async function load(root: string, path: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(resolve(root, path)).href)) as Record<string, unknown>;
}

async function loadReference(root: string): Promise<Reference> {
  const shared = 'packages/shared/src';
  const [crypto, keySlots, argon, recovery, sealing, sessions] = await Promise.all([
    load(root, `${shared}/crypto.mts`),
    load(root, `${shared}/ui/keySlots.mts`),
    load(root, `${shared}/ui/argon2idForTests.mts`),
    load(root, `${shared}/ui/recoveryKey.mts`),
    load(root, `${shared}/sealing.mts`),
    load(root, 'apps/backend/src/services/auth/sessions.ts'),
  ]);
  const createUnlocker = keySlots['createUnlocker'] as (argon2id: unknown) => Unlocker;
  return {
    crypto: crypto as unknown as Crypto,
    unlocker: createUnlocker(argon['testArgon2id']),
    formatRecoveryKey: recovery['formatRecoveryKey'] as Reference['formatRecoveryKey'],
    parseRecoveryKey: recovery['parseRecoveryKey'] as Reference['parseRecoveryKey'],
    hashToken: sessions['hashToken'] as Reference['hashToken'],
    sealing: sealing as Reference['sealing'],
  };
}

async function refuses(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return false;
  } catch {
    return true;
  }
}

function must(condition: boolean, message: string): void {
  if (!condition) throw new Error(`vector generation failed: ${message}`);
}

async function generate(root: string, outDir: string): Promise<void> {
  const ref = await loadReference(root);
  const { crypto: c, unlocker } = ref;
  const b64 = c.toBase64Url;
  const call = <T,>(name: string, ...args: unknown[]): T =>
    (ref.sealing[name] as unknown as (...a: unknown[]) => T)(...args);

  const owners = [] as { owner: string; dataKey: Bytes; keys: Keys }[];
  for (const owner of OWNERS) {
    const dataKey = c.generateDataKey();
    owners.push({ owner, dataKey, keys: await c.deriveKeys(dataKey, owner, { index: true }) });
  }
  const [first, second] = owners as [(typeof owners)[number], (typeof owners)[number]];
  const byName = (name: string) =>
    owners.find((entry) => entry.owner === name) as (typeof owners)[number];

  const keysFile = {
    owners: owners.map(({ owner, dataKey, keys }) => ({
      owner,
      dataKey: b64(dataKey),
      dataKeyText: c.encodeDataKey(dataKey),
      keyId: keys.keyId,
    })),
  };

  const task = {
    kind: 'task',
    id: 'tsk_0001',
    createdBy: 'user',
    scheduleId: null,
    agent: null,
    forkOf: null,
  };
  const rows: Record<string, Row> = {
    plain: task,
    agentic: { ...task, id: 'tsk_0002', createdBy: 'agent', agent: 'reviewer' },
    forked: { ...task, id: 'tsk_0003', forkOf: 'tsk_0001' },
    forkedAgentic: { ...task, id: 'tsk_0004', forkOf: 'tsk_0001', agent: 'reviewer' },
    intake: { ...task, id: 'tsk_0005', createdBy: 'intake' },
    occurrence: { ...task, id: 'tsk_0006', scheduleId: 'sch_0001' },
    schedule: { kind: 'schedule', id: 'sch_0001', agent: null },
    scheduleAgentic: { kind: 'schedule', id: 'sch_0002', agent: 'reviewer' },
  };

  const bindingsFile: Row[] = [];
  const addBinding = (builder: string, args: Row, binding: Binding, extra: Row = {}): Binding => {
    bindingsFile.push({ builder, args, field: binding.field, context: binding.context, ...extra });
    return binding;
  };
  const rowBuilders: [string, string][] = [
    ['title', 'titleBinding'],
    ['agent', 'agentBinding'],
    ['icon', 'iconBinding'],
    ['labels', 'labelsBinding'],
    ['workdir', 'workdirBinding'],
  ];
  for (const [builder, helper] of rowBuilders)
    for (const key of Object.keys(rows)) {
      const row = rows[key] as Row;
      if (builder === 'workdir' && row['kind'] === 'schedule' && key !== 'schedule') continue;
      addBinding(builder, { row }, call<Binding>(helper, row));
    }
  for (const key of [
    'plain',
    'agentic',
    'forked',
    'forkedAgentic',
    'intake',
    'occurrence',
    'schedule',
    'scheduleAgentic',
  ]) {
    const row = rows[key] as Row;
    addBinding('input', { row }, call<Binding>('inputBinding', row));
  }
  for (const key of ['plain', 'agentic', 'forked', 'forkedAgentic', 'occurrence', 'schedule']) {
    const row = rows[key] as Row;
    const base = call<Binding>('inputBinding', row);
    addBinding(
      'input',
      { row, directoryId: 'dir_0001' },
      { field: base.field, context: `${base.context}:directory:dir_0001` },
      { new: true },
    );
  }
  const occurrence = rows['occurrence'] as Row;
  const openBindings = call<Binding[]>('workdirOpenBindings', occurrence);
  addBinding('occurrenceWorkdir', { row: occurrence }, openBindings[0] as Binding);
  addBinding('pr', { taskId: 'tsk_0001' }, call<Binding>('prBinding', 'tsk_0001'));
  addBinding('watches', { taskId: 'tsk_0001' }, call<Binding>('watchesBinding', 'tsk_0001'));
  const machineBuilders: [string, string][] = [
    ['machine.dirs', 'machineDirsBinding'],
    ['machine.catalog', 'machineCatalogBinding'],
    ['machine.usage', 'machineUsageBinding'],
    ['machine.feeds', 'machineFeedsBinding'],
  ];
  for (const [field, helper] of machineBuilders)
    addBinding(
      'machineDocument',
      { field, machine: 'vector-machine' },
      call<Binding>(helper, 'vector-machine'),
    );
  const sharedAgents = (await load(root, 'packages/shared/src/sharedAgents.mts'))[
    'sharedAgentsBinding'
  ];
  const links = (await load(root, 'packages/shared/src/linkRules.mts'))['linkRulesBinding'];
  const titles = (await load(root, 'packages/shared/src/titleRules.mts'))['titleRulesBinding'];
  for (const version of [1, 7]) {
    addBinding('sharedAgents', { version }, (sharedAgents as (v: number) => Binding)(version));
    addBinding('links', { version }, (links as (v: number) => Binding)(version));
    addBinding('titles', { version }, (titles as (v: number) => Binding)(version));
  }
  const noteFields = [
    'note.body',
    'note.preview',
    'note.suggestion',
    'note.questions',
    'note.answers',
  ];
  const noteKinds: [string, string][] = [
    ['agent', 'comment'],
    ['agent', 'question'],
    ['agent', 'polish'],
    ['system', 'event'],
    ['user', 'comment'],
    ['user', 'answer'],
    ['user', 'event'],
  ];
  for (const field of noteFields)
    for (const [author, kind] of noteKinds.slice(0, field === 'note.body' ? 7 : 2))
      addBinding(
        'note',
        { field, taskId: 'tsk_0001', author: author as string, kind: kind as string },
        call<Binding>('noteBinding', field, 'tsk_0001', author, kind),
      );
  for (const field of ['tr.data', 'tr.output'])
    for (const seq of [0, 41])
      addBinding(
        'transcript',
        { field, taskId: 'tsk_0001', runId: 'run_0001', seq },
        call<Binding>('transcriptBinding', field, 'tsk_0001', 'run_0001', seq),
      );
  const added: [string, string, string, string][] = [
    ['projectName', 'project.name', 'project:', 'projectId'],
    ['projectIcon', 'project.icon', 'project:', 'projectId'],
    ['directoryPath', 'directory.path', 'directory:', 'directoryId'],
    ['directoryRepo', 'directory.repo', 'directory:', 'directoryId'],
  ];
  for (const [builder, field, prefix, argName] of added) {
    const id = argName === 'projectId' ? 'prj_0001' : 'dir_0001';
    addBinding(builder, { [argName]: id }, { field, context: `${prefix}${id}` }, { new: true });
  }
  for (const version of [1, 4])
    addBinding(
      'settings',
      { version },
      { field: 'settings', context: `settings:v${version}` },
      { new: true },
    );

  const bindingOf = (builder: string, matcher: (args: Row) => boolean = () => true): Binding => {
    const hit = bindingsFile.find(
      (entry) => entry['builder'] === builder && matcher(entry['args'] as Row),
    );
    must(hit !== undefined, `no binding for ${builder}`);
    return { field: (hit as Row)['field'] as string, context: (hit as Row)['context'] as string };
  };

  const asciiTitle = 'Fix the flaky login test';
  const unicodeInput =
    'Review caf\u00e9 d\u00e9j\u00e0 vu \u{1F680} \u{1F468}\u200d\u{1F469}\u200d\u{1F467} e\u0301 n\u0303 end';
  const tenKiB = Array.from({ length: 10 * 1024 }, (_, i) =>
    String.fromCharCode(97 + (i % 26)),
  ).join('');
  const dirsJson = JSON.stringify({
    dirs: [{ path: '/work/one', label: 'one' }, { path: '/work/two' }],
  });
  const noteBody = 'The tests pass; one follow-up remains.';
  const transcriptData = JSON.stringify({ type: 'assistant', text: 'Reading the file' });
  const caseDefs: { field: string; binding: Binding; plaintext: string }[] = [
    {
      field: 'title',
      binding: bindingOf('title', (a) => (a['row'] as Row)['id'] === 'tsk_0001'),
      plaintext: asciiTitle,
    },
    {
      field: 'input',
      binding: bindingOf(
        'input',
        (a) => (a['row'] as Row)['id'] === 'tsk_0004' && !('directoryId' in a),
      ),
      plaintext: unicodeInput,
    },
    {
      field: 'input',
      binding: bindingOf('input', (a) => (a['row'] as Row)['id'] === 'tsk_0001'),
      plaintext: '',
    },
    {
      field: 'input',
      binding: bindingOf('input', (a) => (a['row'] as Row)['id'] === 'tsk_0002'),
      plaintext: tenKiB,
    },
    {
      field: 'workdir',
      binding: bindingOf('workdir', (a) => (a['row'] as Row)['id'] === 'tsk_0001'),
      plaintext: '/work/one',
    },
    {
      field: 'machine.dirs',
      binding: bindingOf('machineDocument', (a) => a['field'] === 'machine.dirs'),
      plaintext: dirsJson,
    },
    {
      field: 'note.body',
      binding: bindingOf(
        'note',
        (a) => a['field'] === 'note.body' && a['author'] === 'agent' && a['kind'] === 'comment',
      ),
      plaintext: noteBody,
    },
    {
      field: 'tr.data',
      binding: bindingOf('transcript', (a) => a['field'] === 'tr.data' && a['seq'] === 0),
      plaintext: transcriptData,
    },
    {
      field: 'tr.output',
      binding: bindingOf('transcript', (a) => a['field'] === 'tr.output' && a['seq'] === 41),
      plaintext: 'ok\n',
    },
  ];

  const envelopeCases: Row[] = [];
  for (const entry of owners)
    for (const def of caseDefs) {
      const envelope = await c.seal(
        entry.keys,
        def.binding.field,
        def.binding.context,
        def.plaintext,
      );
      must(
        (await c.open(entry.keys, def.binding.field, def.binding.context, envelope)) ===
          def.plaintext,
        'round trip',
      );
      envelopeCases.push({
        owner: entry.owner,
        field: def.binding.field,
        context: def.binding.context,
        plaintext: def.plaintext,
        envelope,
      });
    }

  const titleBinding = caseDefs[0]?.binding as Binding;
  const trBinding = caseDefs[7]?.binding as Binding;
  const noncanonicalPlain = 'abcd';
  const good = {
    title: await c.seal(first.keys, titleBinding.field, titleBinding.context, 'refusal sample'),
    tr: await c.seal(first.keys, trBinding.field, trBinding.context, 'refusal sample'),
    nc: await c.seal(first.keys, titleBinding.field, titleBinding.context, noncanonicalPlain),
  };
  const decode = (envelope: string): Uint8Array => {
    const bytes = c.fromBase64Url(envelope.slice(5));
    must(bytes !== null, 'good envelope decodes');
    return Uint8Array.from(bytes as Uint8Array);
  };
  const flip = (envelope: string, index: number): string => {
    const bytes = decode(envelope);
    bytes[index === -1 ? bytes.length - 1 : index] ^= 1;
    return `abe1.${b64(bytes)}`;
  };
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const lastIndex = alphabet.indexOf(good.nc.at(-1) as string);
  const nonCanonical = `${good.nc.slice(0, -1)}${alphabet[lastIndex | 1] === good.nc.at(-1) ? alphabet[lastIndex | 2] : alphabet[lastIndex | 1]}`;

  must(
    c.fromBase64Url(nonCanonical.slice(5)) === null,
    'non-canonical sample is rejected by decoding',
  );
  must(c.fromBase64Url(good.nc.slice(5)) !== null, 'canonical sample decodes');

  const refusalDefs: {
    reason: string;
    keysOf: string;
    openAs?: string;
    binding: Binding;
    envelope: string;
  }[] = [
    {
      reason: 'tampered-ciphertext',
      keysOf: first.owner,
      binding: titleBinding,
      envelope: flip(good.title, 12),
    },
    {
      reason: 'tampered-nonce',
      keysOf: first.owner,
      binding: titleBinding,
      envelope: flip(good.title, 0),
    },
    {
      reason: 'tampered-tag',
      keysOf: first.owner,
      binding: titleBinding,
      envelope: flip(good.title, -1),
    },
    {
      reason: 'wrong-owner',
      keysOf: first.owner,
      openAs: second.owner,
      binding: titleBinding,
      envelope: good.title,
    },
    {
      reason: 'wrong-field',
      keysOf: first.owner,
      binding: { field: 'icon', context: titleBinding.context },
      envelope: good.title,
    },
    {
      reason: 'wrong-context',
      keysOf: first.owner,
      binding: { field: titleBinding.field, context: 'task:tsk_9999' },
      envelope: good.title,
    },
    {
      reason: 'wrong-key-kind',
      keysOf: first.owner,
      binding: { field: 'title', context: trBinding.context },
      envelope: good.tr,
    },
    {
      reason: 'non-canonical-base64url',
      keysOf: first.owner,
      binding: titleBinding,
      envelope: nonCanonical,
    },
    {
      reason: 'too-short',
      keysOf: first.owner,
      binding: titleBinding,
      envelope: `abe1.${b64(new Uint8Array(27))}`,
    },
    {
      reason: 'bad-prefix',
      keysOf: first.owner,
      binding: titleBinding,
      envelope: `abx1.${good.title.slice(5)}`,
    },
  ];
  const refusals: Row[] = [];
  for (const def of refusalDefs) {
    const entry = byName(def.keysOf);
    const keys = def.openAs
      ? await c.deriveKeys(entry.dataKey, def.openAs, { index: true })
      : entry.keys;
    must(
      await refuses(() => c.open(keys, def.binding.field, def.binding.context, def.envelope)),
      `${def.reason} refused`,
    );
    refusals.push({
      owner: def.keysOf,
      ...(def.openAs ? { openAsOwner: def.openAs } : {}),
      field: def.binding.field,
      context: def.binding.context,
      envelope: def.envelope,
      reason: def.reason,
    });
  }

  const indexValues = [
    '',
    'https://github.com/vector-org/vector-repo/pull/17',
    '0123456789abcdef0123456789abcdef01234567',
    'naïve café 🚀 é',
    'x'.repeat(1024),
  ];
  const indexCases: Row[] = [];
  for (const entry of owners)
    for (const value of indexValues) {
      const index = await c.blindIndex(entry.keys, value);
      must(c.isBlindIndex(index), 'index shape');
      indexCases.push({ owner: entry.owner, value, index });
    }

  const kdfs: Kdf[] = [PRODUCTION_KDF, MINIMUM_KDF];
  const setups: Row[] = [];
  const created: {
    owner: string;
    setup: KeySetup;
    recoveryKey: string;
    kdf: Kdf;
    dataKey: Bytes;
  }[] = [];
  for (const [i, kdf] of kdfs.entries()) {
    const owner = OWNERS[i] as string;
    const result = await unlocker.createKeySetup({ owner, passphrase: PASSPHRASE, kdf });
    const dataKey = await unlocker.openDataKey(result.setup.slots, {
      kind: 'passphrase',
      passphrase: PASSPHRASE,
    });
    const recoveryBytes = await ref.parseRecoveryKey(result.recoveryKey);
    created.push({ owner, setup: result.setup, recoveryKey: result.recoveryKey, kdf, dataKey });
    setups.push({
      owner,
      passphrase: PASSPHRASE,
      kdf: { ...kdf },
      dataKey: b64(dataKey),
      keyId: result.keys.keyId,
      setup: result.setup as unknown as Json,
      recoveryKey: result.recoveryKey,
      recoveryKeyBytes: b64(recoveryBytes),
    });
  }
  const fullWidth = [...PASSPHRASE]
    .map((char) =>
      char === ' '
        ? IDEOGRAPHIC_SPACE
        : String.fromCodePoint((char.codePointAt(0) as number) + 0xfee0),
    )
    .join('');
  const typedVariants: [string, boolean][] = [
    [PASSPHRASE, true],
    [`  ${PASSPHRASE}  `, true],
    [`\t${PASSPHRASE}\n`, true],
    [fullWidth, true],
    [`${IDEOGRAPHIC_SPACE}${fullWidth}${IDEOGRAPHIC_SPACE}`, true],
    ['Correct horse battery staple', false],
  ];
  for (const [typed, opens] of typedVariants)
    for (const entry of created) {
      const secret: Secret = { kind: 'passphrase', passphrase: typed };
      const worked = !(await refuses(() =>
        unlocker.unlockKeys({ owner: entry.owner, stored: entry.setup, secret }),
      ));
      must(worked === opens, `passphrase variant ${JSON.stringify(typed)}`);
    }
  const base = created[1] as (typeof created)[number];
  const newPassphrase = 'a different long passphrase';
  const replacement = await unlocker.replacePassphrase({
    owner: base.owner,
    stored: base.setup,
    secret: { kind: 'passphrase', passphrase: PASSPHRASE },
    newPassphrase,
    kdf: MINIMUM_KDF,
  });
  const reopened = await unlocker.openDataKey(replacement.slots, {
    kind: 'passphrase',
    passphrase: newPassphrase,
  });
  must(b64(reopened) === b64(base.dataKey), 'replaced passphrase keeps the data key');
  must(replacement.keys.keyId === base.setup.keyId, 'replaced passphrase keeps the key id');
  must(
    JSON.stringify(replacement.slots.filter((slot) => slot.kind === 'recovery')) ===
      JSON.stringify(base.setup.slots.filter((slot) => slot.kind === 'recovery')),
    'recovery slot is unchanged',
  );
  const slotsFile = {
    setups,
    variants: typedVariants.map(([typed, opens]) => ({ typed, opens })),
    replaced: {
      owner: base.owner,
      setup: base.setup as unknown as Json,
      dataKey: b64(base.dataKey),
      keyId: base.setup.keyId,
      newPassphrase,
      kdf: { ...MINIMUM_KDF },
      slots: replacement.slots as unknown as Json,
    },
  };

  const recoveryBytes: Bytes[] = [new Uint8Array(32), new Uint8Array(32).fill(255)];
  let sample: Bytes = new Uint8Array(32);
  let sampleText = '';
  while (!(sampleText.includes('0') && sampleText.includes('1'))) {
    sample = c.generateDataKey();
    sampleText = await ref.formatRecoveryKey(sample);
  }
  recoveryBytes.push(sample, c.generateDataKey());
  const recoveryCases: Row[] = [];
  for (const bytes of recoveryBytes) {
    const text = await ref.formatRecoveryKey(bytes);
    must(b64(await ref.parseRecoveryKey(text)) === b64(bytes), 'recovery round trip');
    recoveryCases.push({ bytes: b64(bytes), text });
  }
  const sampleKey = b64(sample);
  const typedInputs = [
    sampleText.toLowerCase(),
    sampleText.replaceAll('-', ''),
    sampleText.replaceAll('-', ' '),
    ` ${sampleText.replaceAll('-', ' - ')} `,
    sampleText.replaceAll('0', 'O'),
    sampleText.replaceAll('1', 'I'),
    sampleText.replaceAll('1', 'l'),
    sampleText.toLowerCase().replaceAll('0', 'o').replaceAll('1', 'i').replaceAll('-', ''),
  ];
  const typed: Row[] = [];
  for (const input of typedInputs) {
    must(b64(await ref.parseRecoveryKey(input)) === sampleKey, `typed recovery ${input}`);
    typed.push({ input, bytes: sampleKey });
  }
  const groups = sampleText.split('-');
  const keyChars = groups.join('').slice(0, 52);
  const spareText = (): string => {
    const head = keyChars.slice(0, 51);
    const lastValue = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(keyChars[51] as string);
    const changed = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[lastValue | 1] as string;
    return head + changed + groups.join('').slice(52);
  };
  const lastCheck = sampleText.at(-1) as string;
  const otherCheck = lastCheck === '2' ? '3' : '2';
  const refusalInputs: [string, string][] = [
    ['checksum', `${sampleText.slice(0, -1)}${otherCheck}`],
    ['length', sampleText.slice(0, -1)],
    ['length', `${sampleText}2`],
    ['alphabet', `U${sampleText.slice(1)}`],
    [
      'spare-bits',
      spareText()
        .match(/.{1,4}/g)
        ?.join('-') as string,
    ],
  ];
  const recoveryRefusals: Row[] = [];
  for (const [reason, input] of refusalInputs) {
    must(await refuses(() => ref.parseRecoveryKey(input)), `recovery ${reason} refused`);
    recoveryRefusals.push({ input, reason });
  }

  const tokenCases: Row[] = [];
  for (const prefix of ['abs_', 'abm_', 'abc_']) {
    const token = `${prefix}${b64(c.generateDataKey())}`;
    const hash = ref.hashToken(token);
    must(
      hash === createHash('sha256').update(token).digest('hex'),
      'token hash is the SHA-256 hex of the whole token',
    );
    tokenCases.push({ token, hash });
  }

  const stamp = { source: SOURCE, generatedBy: GENERATOR };
  const files: Record<string, Json> = {
    'keys.json': { ...stamp, ...keysFile },
    'envelopes.json': { ...stamp, cases: envelopeCases, refusals },
    'blind-indexes.json': { ...stamp, cases: indexCases },
    'bindings.json': { ...stamp, cases: bindingsFile },
    'slots.json': { ...stamp, ...slotsFile },
    'recovery-keys.json': { ...stamp, cases: recoveryCases, typed, refusals: recoveryRefusals },
    'token-hashes.json': {
      ...stamp,
      note: 'The hash is the lower-case hex SHA-256 of the UTF-8 bytes of the whole token, prefix included. abm_ machine tokens are hashed by the same expression in the reference backend machines service.',
      cases: tokenCases,
    },
  };

  const prettier = await import('prettier');
  const options = (await prettier.resolveConfig(join(outDir, 'keys.json'))) ?? {};
  await mkdir(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const text = await prettier.format(`${JSON.stringify(content, null, 2)}\n`, {
      ...options,
      parser: 'json',
    });
    await writeFile(join(outDir, name), text);
  }
}

const [root, outDir] = process.argv.slice(2);
if (!root || !outDir) {
  console.error('usage: generate-vectors.mts <extracted reference root> <output directory>');
  process.exit(2);
}
const restore = installSeededRandom();
try {
  await generate(resolve(root), resolve(outDir));
} finally {
  restore();
}
