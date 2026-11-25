import {
  archiveClientProjectRoute,
  createClientProjectRoute,
  deleteClientProjectRoute,
  listClientProjectsRoute,
  unarchiveClientProjectRoute,
  updateClientProjectRoute,
} from '@agent-board/contract';
import { bindings, open, seal, type Binding, type Keys } from '@agent-board/sealing';

import { OWNER_KEYS, hours, isoAt } from './board-world.js';
import { json } from './fake-board.js';
import { PagesWorld } from './pages-world.js';

export const PROJECT_HOME_ID = '11111111-1111-4111-8111-111111111111';
export const PROJECT_ALPHA = '77777777-7777-4777-8777-777777777771';
export const PROJECT_BRAVO = '77777777-7777-4777-8777-777777777772';

export interface ProjectRow {
  id: string;
  name: string | null;
  icon: string | null;
  isDefault: boolean;
  archived: boolean;
}

export class ProjectsWorld extends PagesWorld {
  rows: ProjectRow[] = [];

  async seedProjects(rows: readonly Omit<ProjectRow, 'archived'>[]): Promise<void> {
    this.rows = rows.map((row) => ({ ...row, archived: false }));
  }

  protected override async answer(
    method: string,
    path: string,
    body: Record<string, unknown> | null,
  ): Promise<Response> {
    if (method === 'GET' && path === listClientProjectsRoute.path) {
      const keys = await OWNER_KEYS;
      return json(200, {
        projects: await Promise.all(
          this.rows.map(async (row, position) => ({
            id: row.id,
            name:
              row.name === null ? null : await seal(keys, bindings.projectName(row.id), row.name),
            icon:
              row.icon === null ? null : await seal(keys, bindings.projectIcon(row.id), row.icon),
            position,
            isDefault: row.isDefault,
            archivedAt: row.archived ? isoAt(-hours(1)) : null,
            createdAt: isoAt(-hours(100)),
            updatedAt: isoAt(-hours(100)),
          })),
        ),
      });
    }
    const request = body ?? {};
    const keys = await OWNER_KEYS;
    const row = this.rows.find((candidate) => candidate.id === request.id);
    switch (path) {
      case createClientProjectRoute.path:
        this.writes.push({ path, body: request });
        this.rows.push({
          id: String(request.id),
          name: await opened(keys, bindings.projectName(String(request.id)), request.name),
          icon: await opened(keys, bindings.projectIcon(String(request.id)), request.icon),
          isDefault: false,
          archived: false,
        });
        return json(200, {});
      case updateClientProjectRoute.path:
        this.writes.push({ path, body: request });
        if (row === undefined) return notFound();
        if (typeof request.name === 'string') {
          row.name = await opened(keys, bindings.projectName(row.id), request.name);
        }
        if ('icon' in request) {
          row.icon = await opened(keys, bindings.projectIcon(row.id), request.icon);
        }
        return json(200, {});
      case archiveClientProjectRoute.path:
      case unarchiveClientProjectRoute.path:
        this.writes.push({ path, body: request });
        if (row === undefined) return notFound();
        row.archived = path === archiveClientProjectRoute.path;
        return json(200, {});
      case deleteClientProjectRoute.path: {
        this.writes.push({ path, body: request });
        if (row === undefined) return notFound();
        const used = this.tasks.some((task) => task.projectId === row.id);
        if (used && request.then === undefined) {
          return json(409, { error: { code: 'conflict', message: 'The project has tasks.' } });
        }
        if (request.then === 'delete') {
          this.tasks = this.tasks.filter((task) => task.projectId !== row.id);
        }
        if (request.then === 'move-to-default') {
          for (const task of this.tasks) {
            if (task.projectId === row.id) task.projectId = PROJECT_HOME_ID;
          }
        }
        this.rows = this.rows.filter((candidate) => candidate.id !== row.id);
        return json(200, {});
      }
      default:
        return super.answer(method, path, body);
    }
  }
}

const opened = async (keys: Keys, binding: Binding, envelope: unknown): Promise<string | null> =>
  typeof envelope === 'string' ? open(keys, binding, envelope) : null;

const notFound = (): Response =>
  json(404, { error: { code: 'not-found', message: 'No such project.' } });
