# agent-board-standalone

A Kanban board for headless Claude Code runs, in one repository with six independently installable parts:

| Part | What it is |
|---|---|
| API/server | Database and orchestration, local or remote |
| Server app | Desktop wrapper that runs the API on one machine |
| CLI | The worker engine on each host where `claude` runs |
| Browser client | The board UI, responsive, by project |
| Client app | Desktop wrapper around the browser client |
| Mobile | Android wrapper around the browser client |

Parts share only the versioned `contract` and `sealing` packages.

Licensed under MIT.
