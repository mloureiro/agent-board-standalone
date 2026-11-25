import { csv, envObject, refuse } from '../env.js';

const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s@]+$/;

export const crossOriginSchema = envObject.transform((env, ctx): string[] => {
  const origins: string[] = [];
  for (const entry of csv(env.ALLOWED_ORIGINS)) {
    const origin = entry.replace(/\/$/, '').toLowerCase();
    if (ORIGIN.test(origin)) origins.push(origin);
    else
      refuse(ctx, 'ALLOWED_ORIGINS', `${entry} is not an origin such as https://app.example.com`);
  }
  return origins;
});
