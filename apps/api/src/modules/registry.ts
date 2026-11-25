import type { z } from 'zod';

import { accessLogModule } from './access-log/index.js';
import { buildModule } from './build/index.js';
import { cleanupModule } from './cleanup/index.js';
import { controlModule } from './control/index.js';
import { crossOriginModule } from './cross-origin/index.js';
import { databaseModule } from './database/index.js';
import { cleanEnv, isLoopbackName, type Env } from './env.js';
import { eventsModule } from './events/index.js';
import { feedsModule } from './feeds/index.js';
import { effectiveHost, listenModule } from './listen/index.js';
import { requestSignatureModule } from './request-signature/index.js';
import { schedulingModule } from './scheduling/index.js';
import { signInModule } from './sign-in/index.js';
import { webModule } from './web/index.js';

export const MODULES = [
  buildModule,
  databaseModule,
  signInModule,
  listenModule,
  crossOriginModule,
  controlModule,
  requestSignatureModule,
  eventsModule,
  schedulingModule,
  feedsModule,
  webModule,
  cleanupModule,
  accessLogModule,
] as const;

export type RegisteredModule = (typeof MODULES)[number];

export type ApiConfig = { [M in RegisteredModule as M['name']]: z.output<M['schema']> };

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export const validateCombination = (config: ApiConfig): string[] => {
  const problems: string[] = [];
  if (config.events === 'postgres' && config.database.kind !== 'postgres')
    problems.push('EVENTS_DRIVER: postgres needs a postgres:// DATABASE_URL');
  if (config.signIn.mode === 'no-login' && !config.requestSignature) {
    const host = effectiveHost(config.listen, false);
    const exposed = [
      ...(isLoopbackName(host) ? [] : [`HOST ${host}`]),
      ...config.listen.allowedHosts
        .filter((name) => !isLoopbackName(name))
        .map((name) => `ALLOWED_HOSTS ${name}`),
    ];
    if (exposed.length > 0)
      problems.push(
        `REQUEST_SIGNATURE: must be "on" when no-login is reachable beyond loopback (${exposed.join(', ')})`,
      );
  }
  return problems;
};

export const loadConfig = (env: Env): ApiConfig => {
  const cleaned = cleanEnv(env);
  const problems: string[] = [];
  const parsed: Record<string, unknown> = {};
  for (const module of MODULES) {
    const result = module.schema.safeParse(cleaned);
    if (result.success) {
      parsed[module.name] = result.data;
    } else {
      for (const issue of result.error.issues)
        problems.push(`${issue.path.join('.') || module.name}: ${issue.message}`);
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
  const config = parsed as ApiConfig;
  const combined = validateCombination(config);
  if (combined.length > 0) throw new ConfigError(combined);
  return config;
};
