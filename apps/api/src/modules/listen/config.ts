import { csv, envObject, onOff, refuse } from '../env.js';

export interface ListenConfig {
  host: string | null;
  port: number;
  allowedHosts: string[];
  trustProxy: boolean;
}

export const DEFAULT_PORT = 4000;
export const LOOPBACK_HOST = '127.0.0.1';
export const ANY_HOST = '0.0.0.0';

const HOSTNAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

export const bareHostname = (value: string): string => {
  const lower = value.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(lower);
  if (bracketed?.[1] !== undefined) return bracketed[1];
  return /^[^:]+:\d+$/.test(lower) ? lower.slice(0, lower.lastIndexOf(':')) : lower;
};

export const listenSchema = envObject.transform((env, ctx): ListenConfig => {
  let port = DEFAULT_PORT;
  if (env.PORT !== undefined) {
    const parsed = Number(env.PORT);
    if (/^\d+$/.test(env.PORT) && parsed <= 65535) port = parsed;
    else refuse(ctx, 'PORT', 'must be a whole number from 0 to 65535 (0 picks a free port)');
  }
  const allowedHosts: string[] = [];
  for (const entry of csv(env.ALLOWED_HOSTS)) {
    const name = entry.toLowerCase();
    if (/^\[.+\]$/.test(name) || name === '::1' || HOSTNAME.test(name)) {
      allowedHosts.push(name.replace(/^\[|\]$/g, ''));
    } else {
      refuse(ctx, 'ALLOWED_HOSTS', `${entry} is not a host name: list names only, without a port`);
    }
  }
  return {
    host: env.HOST ?? null,
    port,
    allowedHosts,
    trustProxy: onOff(env, 'TRUST_PROXY', false, ctx),
  };
});

export const effectiveHost = (listen: ListenConfig, login: boolean): string =>
  listen.host ?? (login ? ANY_HOST : LOOPBACK_HOST);
