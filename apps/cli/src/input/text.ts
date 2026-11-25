import { UsageError } from '../errors.js';
import type { Runtime } from '../runtime.js';
import { readNoteFile } from './note-file.js';

export async function textOf(rt: Runtime, words: readonly string[]): Promise<string> {
  const [first, second] = words;
  let text: string;
  if (first === '-' && words.length === 1) text = (await rt.readStdin()).trim();
  else if (first === '--file' && second !== undefined && words.length === 2) {
    text = readNoteFile(second, rt.platform);
  } else text = words.join(' ').trim();
  if (text === '') throw new UsageError('the text is missing');
  return text;
}
