import { z } from 'zod';

export const SEALED_FIELDS = [
  'title',
  'input',
  'workdir',
  'agent',
  'icon',
  'labels',
  'pr',
  'watches',
  'machine.dirs',
  'machine.catalog',
  'machine.usage',
  'machine.feeds',
  'agents.shared',
  'links',
  'titles',
  'note.body',
  'note.preview',
  'note.suggestion',
  'note.questions',
  'note.answers',
  'tr.data',
  'tr.output',
  'project.name',
  'project.icon',
  'directory.path',
  'directory.repo',
  'settings',
] as const;

export type SealedField = (typeof SEALED_FIELDS)[number];

export const SEALED_LIMITS: Record<SealedField, number> = {
  title: 4 * 300,
  input: 4 * 200_000,
  workdir: 4096,
  agent: 256,
  icon: 128,
  labels: 4096,
  pr: 1024,
  watches: 32 * 1024,
  'machine.dirs': 256 * 1024,
  'machine.catalog': 256 * 1024,
  'machine.usage': 64 * 1024,
  'machine.feeds': 320 * 1024,
  'agents.shared': 256 * 1024,
  links: 512 * 1024,
  titles: 512 * 1024,
  'note.body': 4 * 100_000,
  'note.preview': 4 * 300,
  'note.suggestion': 4 * 2000,
  'note.questions': 256 * 1024,
  'note.answers': 256 * 1024,
  'tr.data': 1024 * 1024,
  'tr.output': 4 * 256 * 1024 + 4096,
  'project.name': 4 * 100,
  'project.icon': 128,
  'directory.path': 4096,
  'directory.repo': 1024,
  settings: 256 * 1024,
};

export const ENVELOPE_PREFIX = 'abe1.';
export const BLIND_INDEX_PREFIX = 'abh1.';
export const WRAPPED_KEY_PREFIX = 'abw1.';

const ENVELOPE_OVERHEAD_BYTES = 28;

export const maxEnvelopeLength = (field: SealedField): number =>
  ENVELOPE_PREFIX.length + Math.ceil(((SEALED_LIMITS[field] + ENVELOPE_OVERHEAD_BYTES) * 4) / 3);

export const sealedField = (field: SealedField) =>
  z
    .string()
    .regex(/^abe1\.[A-Za-z0-9_-]{38,}$/)
    .max(maxEnvelopeLength(field));

export const blindIndexString = z.string().regex(/^abh1\.[A-Za-z0-9_-]{43}$/);
export const wrappedKeyString = z.string().regex(/^abw1\.[A-Za-z0-9_-]{80}$/);
export const keyIdString = z.string().regex(/^[0-9a-f]{16}$/);
export const signingKeyIdString = z.string().regex(/^([0-9a-f]{16}|[A-Za-z0-9_-]{43})$/);

export const KDF_LIMITS = {
  m: { min: 8192, max: 262_144 },
  t: { min: 1, max: 10 },
  p: { min: 1, max: 4 },
} as const;

export const MAX_KEY_SLOTS = 4;

export const kdfParams = z.object({
  m: z.number().int().min(KDF_LIMITS.m.min).max(KDF_LIMITS.m.max),
  t: z.number().int().min(KDF_LIMITS.t.min).max(KDF_LIMITS.t.max),
  p: z.number().int().min(KDF_LIMITS.p.min).max(KDF_LIMITS.p.max),
});

export const passphraseSlot = z
  .object({
    kind: z.literal('passphrase'),
    kdf: z.literal('argon2id'),
    ...kdfParams.shape,
    salt: z.string().regex(/^[A-Za-z0-9_-]{22,86}$/),
    wrapped: wrappedKeyString,
  })
  .strict();

export const recoverySlot = z
  .object({ kind: z.literal('recovery'), wrapped: wrappedKeyString })
  .strict();

export const keySlot = z.discriminatedUnion('kind', [passphraseSlot, recoverySlot]);

export const keySlots = z
  .array(keySlot)
  .min(1)
  .max(MAX_KEY_SLOTS)
  .superRefine((slots, ctx) => {
    const kinds = slots.map((slot) => slot.kind);
    if (new Set(kinds).size !== kinds.length) {
      ctx.addIssue({ code: 'custom', message: 'at most one slot of each kind' });
    }
    if (!kinds.includes('passphrase')) {
      ctx.addIssue({ code: 'custom', message: 'a passphrase slot is required' });
    }
  });

export const keySetup = z.object({ keyId: keyIdString, slots: keySlots }).strict();

export const MACHINE_BODY_LIMIT = 2 * 1024 * 1024;
export const TRANSCRIPT_BODY_LIMIT = 16 * 1024 * 1024;
export const CLIENT_BODY_LIMIT = 2 * 1024 * 1024;
export const ACCOUNT_IMPORT_BODY_LIMIT = 16 * 1024 * 1024;
export const MAX_ACCOUNT_IMPORT_ROWS = 1000;
export const MAX_OUTPUT_SIZE = 256 * 1024 + 1024;

export const SAML_FORM_BODY_LIMIT = 256 * 1024;
