export class CookieJar {
  private readonly values = new Map<string, string>();

  get(name: string): string | undefined {
    return this.values.get(name);
  }

  set(name: string, value: string): void {
    this.values.set(name, value);
  }

  clear(): void {
    this.values.clear();
  }

  names(): string[] {
    return [...this.values.keys()];
  }

  header(): string | null {
    if (this.values.size === 0) return null;
    return [...this.values].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  store(setCookies: readonly string[]): void {
    for (const line of setCookies) {
      const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const maxAge = attributes
        .map((attribute) => /^max-age=(-?\d+)$/i.exec(attribute)?.[1])
        .find((match) => match !== undefined);
      const expired = maxAge !== undefined && Number(maxAge) <= 0;
      if (value === '' || expired) this.values.delete(name);
      else this.values.set(name, value);
    }
  }
}
