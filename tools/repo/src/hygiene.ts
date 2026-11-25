import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface HygieneRule {
  readonly name: string;
  readonly pattern: RegExp;
}

export interface AllowEntry {
  readonly path: string;
  readonly rule: string;
  readonly reason: string;
}

export interface Finding {
  readonly path: string;
  readonly line: number;
  readonly rule: string;
}

export const RULES: readonly HygieneRule[] = [
  { name: 'home-path-macos', pattern: /\/Users\/[A-Za-z0-9._-]+/ },
  { name: 'home-path-linux', pattern: /\/home\/[A-Za-z0-9._-]+/ },
  { name: 'home-path-windows', pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9._ -]+\\/ },
  {
    name: 'session-id',
    pattern: /\blocal_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/,
  },
  { name: 'pem-private-key', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { name: 'jwk-private-d', pattern: /["']d["']\s*:\s*["'][A-Za-z0-9_-]{20,}["']/ },
  { name: 'board-token', pattern: /\b(?:abs|abc|abm)_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/ },
  {
    name: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/,
  },
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
];

export function scanText(
  path: string,
  text: string,
  rules: readonly HygieneRule[] = RULES,
): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((content, index) => {
    for (const rule of rules) {
      if (rule.pattern.test(content)) findings.push({ path, line: index + 1, rule: rule.name });
    }
  });
  return findings;
}

export function applyAllowList(
  findings: readonly Finding[],
  allow: readonly AllowEntry[],
): Finding[] {
  return findings.filter(
    (finding) => !allow.some((entry) => entry.path === finding.path && entry.rule === finding.rule),
  );
}

export function parseAllowList(text: string): AllowEntry[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('the allow list must be a JSON array');
  return parsed.map((entry, index) => {
    const { path, rule, reason } = (entry ?? {}) as Record<string, unknown>;
    if (
      typeof path !== 'string' ||
      typeof rule !== 'string' ||
      typeof reason !== 'string' ||
      reason.trim() === ''
    ) {
      throw new Error(`allow list entry ${index} needs a path, a rule and a reason`);
    }
    return { path, rule, reason };
  });
}

export function formatFinding(finding: Finding): string {
  return `${finding.path}:${finding.line} ${finding.rule}`;
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

function main(): number {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const allow = parseAllowList(
    readFileSync(fileURLToPath(new URL('../hygiene-allow.json', import.meta.url)), 'utf8'),
  );
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const findings: Finding[] = [];
  for (const file of files) {
    let buffer: Buffer;
    try {
      buffer = readFileSync(`${root}/${file}`);
    } catch {
      continue;
    }
    if (isBinary(buffer)) continue;
    findings.push(...scanText(file, buffer.toString('utf8')));
  }
  const remaining = applyAllowList(findings, allow);
  for (const finding of remaining) console.error(formatFinding(finding));
  console.log(
    `hygiene: ${files.length} files, ${findings.length - remaining.length} allowed, ${remaining.length} findings`,
  );
  return remaining.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();
