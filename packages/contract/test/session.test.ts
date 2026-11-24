import { describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_TOKEN_KINDS,
  isJsonContentType,
  sessionCookieName,
  tokenKind,
} from '../src/index.js';

const body = 'A'.repeat(43);

describe('session', () => {
  it('[contract-008] cookie name is __Host-board-session on https and board-session on http', () => {
    expect(sessionCookieName('https')).toBe('__Host-board-session');
    expect(sessionCookieName('http')).toBe('board-session');
  });

  it('[contract-008] tokenKind reads abs_, abc_ and abm_ tokens of 43 base64url characters and nothing else', () => {
    expect(tokenKind(`abs_${body}`)).toBe('session');
    expect(tokenKind(`abc_${body}`)).toBe('client');
    expect(tokenKind(`abm_${body}`)).toBe('machine');
    expect(tokenKind(`abx_${body}`)).toBeNull();
    expect(tokenKind(`abm_${body.slice(1)}`)).toBeNull();
    expect(tokenKind(`abm_${body}A`)).toBeNull();
    expect(tokenKind(`abm_${body.slice(1)}+`)).toBeNull();
    expect(tokenKind(` abm_${body}`)).toBeNull();
  });

  it('[contract-008] only client and machine tokens may travel in Authorization', () => {
    expect(AUTHORIZATION_TOKEN_KINDS).toEqual(['client', 'machine']);
  });

  it('[contract-008] writes need application/json', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('Application/JSON; charset=utf-8')).toBe(true);
    expect(isJsonContentType('text/plain')).toBe(false);
    expect(isJsonContentType('application/jsonp')).toBe(false);
    expect(isJsonContentType(null)).toBe(false);
  });
});
