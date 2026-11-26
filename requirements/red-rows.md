# Rows whose test is still red

Every catalogue row has a test (`e2e` or `part`), is manual, or is retired. The rows below have a test that is still listed in
`e2e/expected-red.json` after step 12, so CI skips it on pushes; the six-hourly full run (`E2E_LISTED=run`) runs it and reports
when it starts to pass. Each entry says why it is red and what turns it green. Remove the entry when the row leaves the list.

## Waiting on a feature that is not built

| Row      | Test                                           | Why red                                                                                                                                   | What turns it green     |
| -------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| repo-003 | `blackbox/matrix-refusal.test.ts` (whole file) | Runs only when the matrix job tests N against N-1 and expects a refusal; no `<part>-v*` release tag exists yet, so there is no N-1 build. | The first release tags. |

## Cross-part behaviour still to fix

"Observed" is what the last step 12 run showed; a cause is given only where it was traced.

| Row     | Test                                                                                                    | Observed                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| api-056 | `browser/proposals.spec.ts` "an agent-created task is a Backlog proposal that no machine claims"        | The proposal carries the creating worker's machine (`worker-…`) where the test expects none. |
| web-048 | `browser/task-page.spec.ts` "the / skill list opened from the reply box is fully visible…"              | No `Skills` listbox appears.                                                                 |
| web-050 | `browser/task-page.spec.ts` "on a running task Stop & send interrupts the run and delivers the message" | The message does not reach the run.                                                          |
| web-059 | `browser/transcript.spec.ts` "the drawer lists every run of a task and shows thinking"                  | The thinking text of the run is not shown in the drawer.                                     |
