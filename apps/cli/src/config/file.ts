import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { Document, parseDocument } from 'yaml';

import { CliError } from '../errors.js';
import { CONFIG_FILE, writeAtomic } from '../profile/files.js';
import { configProblem } from './schema.js';

export function configPath(dir: string): string {
  return path.join(dir, CONFIG_FILE);
}

export function readConfigDocument(dir: string): Document {
  const file = configPath(dir);
  if (!existsSync(file)) return new Document({});
  const document = parseDocument(readFileSync(file, 'utf8'));
  if (document.errors.length > 0) throw new CliError(`${file} is not valid YAML`);
  if (document.contents === null) return new Document({});
  return document;
}

export function configObject(document: Document): Record<string, unknown> {
  const value: unknown = document.toJS();
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readConfigObject(dir: string): Record<string, unknown> {
  return configObject(readConfigDocument(dir));
}

export function checkConfig(document: Document): void {
  const problem = configProblem(document.toJS());
  if (problem !== null) throw new CliError(`config.yaml would not be valid: ${problem}`);
}

export function writeConfigDocument(dir: string, document: Document): void {
  checkConfig(document);
  const file = configPath(dir);
  const target = existsSync(file) ? realpathSync(file) : file;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o644;
  writeAtomic(target, document.toString(), mode);
}

export function editConfig(dir: string, change: (document: Document) => void): void {
  const document = readConfigDocument(dir);
  change(document);
  writeConfigDocument(dir, document);
}
