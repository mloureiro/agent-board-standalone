import { describe, expect, it } from 'vitest';

import { clientRoutes } from '../src/index.js';

describe('client route table', () => {
  it('[contract-003] client routes:', () => {
    expect(clientRoutes.map((entry) => `${entry.method} ${entry.path}`).sort())
      .toMatchInlineSnapshot(`
      [
        "GET /api/client/account/export",
        "GET /api/client/account/summary",
        "GET /api/client/agents/shared",
        "GET /api/client/attention",
        "GET /api/client/devices/list",
        "GET /api/client/directories/list",
        "GET /api/client/events",
        "GET /api/client/feeds/list",
        "GET /api/client/keys/get",
        "GET /api/client/links/get",
        "GET /api/client/machines/advertised-cli",
        "GET /api/client/machines/catalogs",
        "GET /api/client/machines/list",
        "GET /api/client/me",
        "GET /api/client/passkeys/list",
        "GET /api/client/projects/list",
        "GET /api/client/revision",
        "GET /api/client/schedules/list",
        "GET /api/client/settings/get",
        "GET /api/client/tasks/get",
        "GET /api/client/tasks/list",
        "GET /api/client/title-rules/get",
        "GET /api/client/transcript/context",
        "GET /api/client/transcript/events",
        "GET /api/client/transcript/output",
        "GET /api/client/transcript/runs",
        "POST /api/client/account/delete",
        "POST /api/client/account/import",
        "POST /api/client/devices/revoke",
        "POST /api/client/directories/move",
        "POST /api/client/feeds/request",
        "POST /api/client/keys/replace-slots",
        "POST /api/client/keys/setup",
        "POST /api/client/links/set",
        "POST /api/client/machines/issue",
        "POST /api/client/machines/revoke",
        "POST /api/client/machines/set-grant",
        "POST /api/client/passkeys/register",
        "POST /api/client/passkeys/register-options",
        "POST /api/client/passkeys/remove",
        "POST /api/client/passkeys/rename",
        "POST /api/client/projects/archive",
        "POST /api/client/projects/create",
        "POST /api/client/projects/delete",
        "POST /api/client/projects/unarchive",
        "POST /api/client/projects/update",
        "POST /api/client/schedules/remove",
        "POST /api/client/schedules/set-paused",
        "POST /api/client/schedules/update",
        "POST /api/client/settings/set",
        "POST /api/client/tasks/answer",
        "POST /api/client/tasks/apply-polish",
        "POST /api/client/tasks/configure",
        "POST /api/client/tasks/create",
        "POST /api/client/tasks/dismiss-question",
        "POST /api/client/tasks/done",
        "POST /api/client/tasks/edit",
        "POST /api/client/tasks/fork",
        "POST /api/client/tasks/move",
        "POST /api/client/tasks/remove-pr",
        "POST /api/client/tasks/reply",
        "POST /api/client/tasks/rerun",
        "POST /api/client/tasks/send",
        "POST /api/client/tasks/set-closed",
        "POST /api/client/tasks/set-not-before",
        "POST /api/client/tasks/set-priority",
        "POST /api/client/tasks/set-project",
        "POST /api/client/tasks/stop",
        "POST /api/client/tasks/stop-watch",
        "POST /api/client/tasks/take-back",
        "POST /api/client/tasks/wake-now",
        "POST /api/client/title-rules/set",
      ]
    `);
  });

  it('[contract-003] client routes are named from their path and only machines/issue issues a credential', () => {
    for (const entry of clientRoutes) {
      expect(entry.name).toBe(
        `client.${entry.path.slice('/api/client/'.length).replace('/', '.')}`,
      );
    }
    expect(
      clientRoutes.filter((entry) => entry.issuesCredential).map((entry) => entry.name),
    ).toEqual(['client.machines.issue']);
  });
});
