import type { ReactNode } from 'react';

import { usePageTitle } from '../../components/index.js';
import { BoardView } from '../board/index.js';

const BACKLOG_ONLY = ['backlog'] as const;

export function BacklogPage(): ReactNode {
  usePageTitle('Backlog');
  return <BoardView heading="Backlog" only={BACKLOG_ONLY} />;
}
