import type { ReactNode } from 'react';

import { usePageTitle } from '../../components/index.js';
import { BoardView } from './BoardView.js';

export function BoardPage(): ReactNode {
  usePageTitle('Board');
  return <BoardView heading="Board" />;
}
