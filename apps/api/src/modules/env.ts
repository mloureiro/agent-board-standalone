import { z } from 'zod';

export type Env = Readonly<Record<string, string | undefined>>;

export const cleanEnv = (env: Env): Record<string, string> => {
  const cleaned: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    const trimmed = value?.trim();
    if (trimmed) cleaned[name] = trimmed;
  }
  return cleaned;
};

export const envObject = z.record(z.string(), z.string());

export type EnvInput = z.infer<typeof envObject>;

export const refuse = (ctx: z.RefinementCtx, variable: string, message: string): void => {
  ctx.addIssue({ code: 'custom', path: [variable], message });
};

export const onOff = (env: EnvInput, name: string, fallback: boolean, ctx: z.RefinementCtx) => {
  const value = env[name]?.toLowerCase();
  if (value === undefined) return fallback;
  if (value === 'on') return true;
  if (value === 'off') return false;
  refuse(ctx, name, 'must be "on" or "off"');
  return fallback;
};

export const csv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

export const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '::1'] as const;

export const isLoopbackName = (name: string): boolean => {
  const bare = name.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    bare === 'localhost' ||
    bare.endsWith('.localhost') ||
    bare === '::1' ||
    /^127\.\d+\.\d+\.\d+$/.test(bare)
  );
};
