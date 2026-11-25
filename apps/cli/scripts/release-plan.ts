export interface ReleaseInput {
  readonly version: string;
  readonly packageJson: string;
  readonly versionSource: string;
  readonly changelog: string;
  readonly notes: string;
}

export interface ReleasePlan {
  readonly packageJson: string;
  readonly versionSource: string;
  readonly changelog: string;
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const UNRELEASED_HEADINGS = ['## Unreleased', '## 0.0.0'];

export function planRelease(input: ReleaseInput): ReleasePlan {
  const { version } = input;
  if (!SEMVER.test(version)) throw new Error(`"${version}" is not a plain x.y.z version`);

  const manifest = JSON.parse(input.packageJson) as { version?: string };
  if (manifest.version === version) throw new Error(`package.json already says ${version}`);
  const packageJson = input.packageJson.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);

  if (!/export const PART_VERSION = '[^']+';/.test(input.versionSource)) {
    throw new Error('src/version.ts has no PART_VERSION line');
  }
  const versionSource = input.versionSource.replace(
    /(export const PART_VERSION = ')[^']+(';)/,
    `$1${version}$2`,
  );

  const lines = input.changelog.split('\n');
  if (lines.some((line) => line.trim() === `## ${version}`)) {
    throw new Error(`CHANGELOG.md already has a "## ${version}" heading`);
  }
  const unreleased = lines.findIndex((line) => UNRELEASED_HEADINGS.includes(line.trim()));
  const notes = input.notes.trim();
  let changelog: string;
  if (unreleased >= 0) {
    const next = lines.findIndex((line, at) => at > unreleased && line.startsWith('## '));
    const body = lines
      .slice(unreleased + 1, next < 0 ? lines.length : next)
      .join('\n')
      .trim();
    const kept = body === '' || body === 'Not released' ? notes : body;
    if (kept === '') throw new Error('the changelog has no notes for this release; pass --notes');
    changelog = [
      ...lines.slice(0, unreleased),
      `## ${version}`,
      '',
      kept,
      '',
      ...(next < 0 ? [] : lines.slice(next)),
    ]
      .join('\n')
      .replace(/\n+$/, '\n');
  } else {
    if (notes === '') throw new Error('the changelog has no notes for this release; pass --notes');
    const title = lines.findIndex((line) => line.startsWith('# '));
    changelog = [
      ...lines.slice(0, title + 1),
      '',
      `## ${version}`,
      '',
      notes,
      ...lines.slice(title + 1),
    ].join('\n');
  }
  return { packageJson, versionSource, changelog };
}

export function releaseCommands(version: string): string[] {
  const tag = `cli-v${version}`;
  return [
    `git add apps/cli/package.json apps/cli/src/version.ts apps/cli/CHANGELOG.md`,
    `git commit -m "Prepare the CLI release ${version}"`,
    `git tag -a ${tag} -m "cli ${version}"`,
    `git push origin ${tag}`,
  ];
}
