import { git, programProblem } from './git.js';
import { MANIFEST_PATH, parseMarketplace, type Marketplace } from './manifest.js';
import type { Runtime } from '../runtime.js';

export async function loadMarketplace(
  rt: Runtime,
  checkout: string,
  commit: string,
): Promise<Marketplace | string> {
  const shown = await git(rt, checkout, ['show', `${commit}:${MANIFEST_PATH}`]);
  if (!shown.ok) return `no ${MANIFEST_PATH} at commit ${commit.slice(0, 12)}`;
  const marketplace = parseMarketplace(shown.out);
  if (typeof marketplace === 'string') return marketplace;
  for (const [key, integration] of Object.entries(marketplace.integrations)) {
    const problem = await programProblem(rt, checkout, commit, integration.program);
    if (problem !== null) return `${key}: ${problem}`;
  }
  return marketplace;
}

export async function pinProblem(
  rt: Runtime,
  name: string,
  checkout: string,
  commit: string,
): Promise<string | null> {
  const head = await git(rt, checkout, ['rev-parse', 'HEAD']);
  if (!head.ok)
    return `marketplace ${name}: the checkout ${checkout} is missing; remove it with rumo plugins remove ${name} and install it again`;
  if (head.out !== commit) {
    return `marketplace ${name} is not at its pinned commit ${commit.slice(0, 12)} (HEAD ${head.out.slice(0, 12)}); run rumo plugins update ${name} to accept the new code`;
  }
  const status = await git(rt, checkout, ['status', '--porcelain', '--untracked-files=no']);
  if (!status.ok) return `git failed in ${checkout}`;
  return status.out === ''
    ? null
    : `marketplace ${name} has local changes in ${checkout}; discard them with git checkout -- . there`;
}
