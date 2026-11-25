import { listMachinesRoute } from '@agent-board/contract';

import { localTime } from '../../domain/time.js';
import { plain } from '../../domain/rules.js';
import type { Context } from '../context.js';
import { session } from '../tasks/support.js';

export async function runMachines(ctx: Context, options: { json?: boolean }): Promise<void> {
  const s = await session(ctx);
  const { machines } = await s.query(listMachinesRoute, {});
  if (options.json === true) {
    ctx.out(JSON.stringify(machines));
    return;
  }
  const width = Math.max(...machines.map((machine) => machine.name.length), 0);
  for (const machine of machines) {
    const seen =
      machine.lastSeenAt === null
        ? 'never seen'
        : `last seen ${localTime(new Date(machine.lastSeenAt))}`;
    ctx.out(
      `${plain(machine.name).padEnd(width)}  ${seen}${machine.current ? '  (this machine)' : ''}`,
    );
  }
}
