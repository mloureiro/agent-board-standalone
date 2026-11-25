import { PGlite as Pglite16 } from 'pglite-0-5-16';
import { PGlite as Pglite17 } from 'pglite-0-5-17';

export type PgliteAlias = 'pglite-0-5-16' | 'pglite-0-5-17';

type PgliteConstructor = typeof Pglite17;
export type PgliteInstance = InstanceType<PgliteConstructor>;

export const PGLITE_CONSTRUCTORS: Readonly<Record<PgliteAlias, PgliteConstructor>> = {
  'pglite-0-5-16': Pglite16 as unknown as PgliteConstructor,
  'pglite-0-5-17': Pglite17,
};

/** PGlite 0.5.16 and 0.5.17 both write PG_VERSION 18, so the file alone cannot choose the build. */
export const ALIASES_BY_PG_MAJOR: Readonly<Record<string, readonly PgliteAlias[]>> = {
  '18': ['pglite-0-5-17', 'pglite-0-5-16'],
};
