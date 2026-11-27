import { Title, VisuallyHidden } from '@mantine/core';
import type { TaskStatus } from '@rumo/contract';
import type { ReactNode } from 'react';

import { useServers } from '../../servers/index.js';
import { Board } from './Board.js';
import { useBoardData } from './board-data.js';
import { MultiBoard } from './MultiBoard.js';

function SingleBoard(props: { readonly only?: readonly TaskStatus[] }): ReactNode {
  const data = useBoardData();
  return data === null ? null : (
    <Board sources={[data]} {...(props.only === undefined ? {} : { only: props.only })} />
  );
}

export function BoardView(props: {
  readonly heading: string;
  readonly only?: readonly TaskStatus[];
}): ReactNode {
  const { viewed } = useServers();
  const only = props.only === undefined ? {} : { only: props.only };
  return (
    <>
      <VisuallyHidden>
        <Title order={1}>{props.heading}</Title>
      </VisuallyHidden>
      {viewed.length > 1 ? <MultiBoard {...only} /> : <SingleBoard {...only} />}
    </>
  );
}
