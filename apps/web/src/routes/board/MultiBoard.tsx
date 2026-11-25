import type { TaskStatus } from '@agent-board/contract';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { SignInPage } from '../../auth/index.js';
import { ServerStatePanel, panelFor } from '../../components/index.js';
import { KeyGate } from '../../keys/index.js';
import { PairingPanel } from '../../pairing/index.js';
import { ServerScope, useServers, type ServerEntry } from '../../servers/index.js';
import { Board } from './Board.js';
import { useBoardData, type BoardData } from './board-data.js';

type Report = (serverId: string, data: BoardData | null) => void;

function Feeder(props: { readonly serverId: string; readonly report: Report }): null {
  const { serverId, report } = props;
  const data = useBoardData();
  useEffect(() => {
    report(serverId, data);
  }, [serverId, report, data]);
  useEffect(() => () => report(serverId, null), [serverId, report]);
  return null;
}

function Pane(props: { readonly server: ServerEntry; readonly report: Report }): ReactNode {
  const { server, report } = props;
  const { connectionOf, hasAnswered } = useServers();
  const view = connectionOf(server.id);
  if (view.state === 'signed-out')
    return <SignInPage server={server} signedOut={hasAnswered(server.id)} />;
  if (view.state === 'needs-pairing') return <PairingPanel server={server} />;
  const panel = panelFor(view);
  if (panel !== null) return <ServerStatePanel content={panel} />;
  if (view.state !== 'up') return null;
  return (
    <KeyGate>
      <Feeder serverId={server.id} report={report} />
    </KeyGate>
  );
}

export function MultiBoard(props: { readonly only?: readonly TaskStatus[] }): ReactNode {
  const { viewed } = useServers();
  const [reported, setReported] = useState<Readonly<Record<string, BoardData>>>({});
  const report = useCallback<Report>((serverId, data) => {
    setReported((current) => {
      if (data === null)
        return serverId in current
          ? Object.fromEntries(Object.entries(current).filter(([id]) => id !== serverId))
          : current;
      return current[serverId] === data ? current : { ...current, [serverId]: data };
    });
  }, []);
  const sources = viewed.flatMap((server) => reported[server.id] ?? []);
  return (
    <>
      {viewed.map((server) => (
        <ServerScope key={server.id} server={server}>
          <Pane server={server} report={report} />
        </ServerScope>
      ))}
      {sources.length === 0 ? null : (
        <Board
          sources={sources}
          showServers
          {...(props.only === undefined ? {} : { only: props.only })}
        />
      )}
    </>
  );
}
