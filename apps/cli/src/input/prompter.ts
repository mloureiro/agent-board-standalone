import { confirm, isCancel, password, text } from '@clack/prompts';

export interface Prompter {
  text(message: string, placeholder?: string): Promise<string | null>;
  secret(message: string): Promise<string | null>;
  confirm(message: string): Promise<boolean | null>;
}

function answered<T extends string | boolean>(value: T | symbol): T | null {
  return isCancel(value) || typeof value === 'symbol' ? null : value;
}

export function terminalPrompter(): Prompter {
  const output = process.stderr;
  return {
    text: async (message, placeholder) =>
      answered<string>(
        await text({
          message,
          output,
          ...(placeholder === undefined ? {} : { placeholder }),
        }),
      ),
    secret: async (message) => answered<string>(await password({ message, output })),
    confirm: async (message) => answered<boolean>(await confirm({ message, output })),
  };
}
