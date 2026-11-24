import { z } from 'zod';

export const DOCTOR_CHECK_IDS = [
  'node',
  'config dir',
  'web.json',
  'env',
  'env mode',
  'token',
  'data key',
  'server',
  'server features',
  'board key',
  'dirs on board',
  'catalog on board',
  "board's agents",
  'agents.replaced',
  'agents',
  'config.json',
  'dirs',
  'usage limits',
  'worker',
  'folders',
  'run directory',
  'launchd agents',
  'unit agent-board-intake',
  'listen command',
  'watch command',
  'dispatch command',
  'listen state',
  'watch state',
  'dispatch state',
  'git',
  'migration',
  'auto-update',
  'backups',
  'profile',
  'request-signature',
  'legacy-dirs',
] as const;

export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];

export const doctorCheckId = z.enum(DOCTOR_CHECK_IDS);

export const DOCTOR_LEVELS = ['ok', 'warn', 'fail'] as const;

export const doctorResult = z
  .object({
    name: doctorCheckId,
    level: z.enum(DOCTOR_LEVELS),
    message: z.string(),
    hint: z.string().optional(),
  })
  .strict();

export const doctorReport = z.array(doctorResult);

export type DoctorResult = z.infer<typeof doctorResult>;
