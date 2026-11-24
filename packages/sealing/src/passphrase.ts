export const MIN_PASSPHRASE_LENGTH = 14;

export function normalizePassphrase(passphrase: string): string {
  return passphrase.trim().normalize('NFKC');
}

export function passphraseProblem(passphrase: string): string | null {
  const length = Array.from(normalizePassphrase(passphrase)).length;
  return length < MIN_PASSPHRASE_LENGTH
    ? `A passphrase needs at least ${MIN_PASSPHRASE_LENGTH} characters.`
    : null;
}
