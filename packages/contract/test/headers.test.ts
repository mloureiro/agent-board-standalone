import { describe, expect, it } from 'vitest';
import {
  ASSET_HEADERS,
  DATA_HEADERS,
  HSTS_HEADER,
  PAGE_HEADERS,
  VERSION_CORS_HEADERS,
  WEB_CSP,
} from '../src/index.js';

describe('headers', () => {
  it('[contract-015] data answers carry the sandbox CSP, nosniff, no-store and attachment', () => {
    expect(DATA_HEADERS['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(DATA_HEADERS['x-content-type-options']).toBe('nosniff');
    expect(DATA_HEADERS['cache-control']).toBe('no-store');
    expect(DATA_HEADERS['content-disposition']).toBe('attachment');
    expect(DATA_HEADERS['content-type']).toBe('application/json; charset=utf-8');
  });

  it('[contract-015] header names are lower case', () => {
    for (const table of [
      DATA_HEADERS,
      PAGE_HEADERS,
      ASSET_HEADERS,
      HSTS_HEADER,
      VERSION_CORS_HEADERS,
    ]) {
      for (const name of Object.keys(table)) expect(name).toBe(name.toLowerCase());
    }
    expect(PAGE_HEADERS['content-security-policy']).toBe(WEB_CSP);
    expect(VERSION_CORS_HEADERS['access-control-allow-origin']).toBe('*');
  });

  it('[contract-015] the browser client CSP allows connect-src to https and loopback http only, and wasm-unsafe-eval', () => {
    const connect = WEB_CSP.split('; ').find((directive) => directive.startsWith('connect-src'));
    expect(connect).toBe(
      "connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*",
    );
    expect(WEB_CSP).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(WEB_CSP).toContain("frame-ancestors 'none'");
  });
});
