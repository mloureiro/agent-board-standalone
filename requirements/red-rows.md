# Rows whose test is still red

Every catalogue row has a test (`e2e` or `part`), is manual, or is retired. The rows below have a test that is still listed in
`e2e/expected-red.json` after step 12, so CI skips it on pushes; the six-hourly full run (`E2E_LISTED=run`) runs it and reports
when it starts to pass. Each entry says why it is red and what turns it green. Remove the entry when the row leaves the list.

## Waiting on a feature that is not built

| Row      | Test                                                                        | Why red                                                                                                                                                     | What turns it green                   |
| -------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| web-035  | `browser/board.spec.ts` "a running card shows context usage as a thin line" | The web client has no context-usage line; the contract has no `context-usage` feature (parked A9). The CLI records context as a `context` transcript event. | A contract feature and the card line. |
| web-060  | `browser/transcript.spec.ts` "the context bar shows percentage used…"       | Same as web-035: no context bar in the transcript drawer.                                                                                                   | Same.                                 |
| repo-003 | `blackbox/matrix-refusal.test.ts` (whole file)                              | Runs only when the matrix job tests N against N-1 and expects a refusal; no `<part>-v*` release tag exists yet, so there is no N-1 build.                   | The first release tags.               |

## The test and the documented behaviour disagree

| Row     | Test                                                                                       | Disagreement                                                                                                                                                                                              | Decision needed                                                  |
| ------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| web-061 | `browser/new-task.spec.ts` "the form takes prompt, project, … auto-done"                   | The test picks a directory of the default project after switching the form to a new project; web-084 (`apps/web/test/projects.test.ts`) lists only the chosen project's directories.                      | Change the test to register the directory under the new project. |
| web-080 | `browser/accessibility.spec.ts` "the task page is operable by keyboard alone…" (chromium)  | Tab lands on the preselected radio of a question (web-055 preselects the recommended option); the test expects the first radio.                                                                           | Let the test accept the checked radio of a group as its stop.    |
| P-10    | `browser/parity.spec.ts` "after sign-out elsewhere the event stream ends…" (chromium only) | The API ends the stream at the sign-out and the client shows sign-in (passes in WebKit); under Chromium Playwright reports no `requestfinished` for the ended streaming fetch, and the test waits for it. | Wait for the 401 reconnect instead of `requestfinished`.         |

## Cross-part behaviour still to fix

"Observed" is what the last step 12 run showed; a cause is given only where it was traced.

| Row           | Test                                                                                                                            | Observed                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| api-119       | `blackbox/user-commands.test.ts` answer / dismiss-question "answers 409 run-holds-task from the machine holding the active run" | The API does not answer 409 `run-holds-task` to the machine whose run holds the task.                     |
| cli-029       | `blackbox/user-commands.test.ts` "board reply and send refuse inside a run before sending"                                      | The stub `claude` keeps one stdin log across runs, so the check reads an earlier run's input (fixture).   |
| cli-029       | `blackbox/user-commands.test.ts` "board reply --resume sends the task back to the top of Todo"                                  | The task is queued `fresh` instead of `resume`: the fixture task has no session to resume.                |
| api-077       | `blackbox/schedules.test.ts` "an after schedule fires once more for running to done on a second run"                            | The second firing does not happen within the test's 60 s.                                                 |
| api-056       | `browser/proposals.spec.ts` "an agent-created task is a Backlog proposal that no machine claims"                                | The proposal carries the creating worker's machine (`worker-…`) where the test expects none.              |
| web-048       | `browser/task-page.spec.ts` "the / skill list opened from the reply box is fully visible…"                                      | No `Skills` listbox appears.                                                                              |
| web-050       | `browser/task-page.spec.ts` "on a running task Stop & send interrupts the run and delivers the message"                         | The message does not reach the run.                                                                       |
| web-058       | `browser/task-page.spec.ts` "the reply box keeps focus, caret and text when the run status changes"; P-18 (WebKit)              | The caret moves to the end of the text (36 instead of 5) when the run status changes.                     |
| web-059       | `browser/transcript.spec.ts` "the drawer lists every run of a task and shows thinking"                                          | The thinking text of the run is not shown in the drawer.                                                  |
| web-055       | `browser/questions.spec.ts` "mod+Enter submits the answer" (chromium)                                                           | Control+Enter does not submit the question form in Chromium.                                              |
| web-064       | `browser/new-task.spec.ts` "drafts clear on send"                                                                               | After the answer the stub resumes without asking again, so the question form the test types into is gone. |
| web-014, P-05 | `browser/sign-in.spec.ts` SAML return and SAML error; `browser/parity.spec.ts` SAML redirect (WebKit only)                      | SAML sign-in passes in Chromium and fails in WebKit; not yet diagnosed.                                   |
| web-029       | `browser/board.spec.ts` "a touch drag moves a card between columns on a phone" (phones)                                         | Touch drag does not move the card under the emulated phones; not yet diagnosed.                           |
| web-029       | `browser/board.spec.ts` "cards reorder within Backlog and the order persists after a reload" (WebKit desktop)                   | Passes in Chromium and locally in WebKit; fails on the Linux WebKit runner; not yet diagnosed.            |
| web-098       | `browser/responsive.spec.ts` "the project filter journey completes at the phone viewport" (WebKit desktop only)                 | Passes on both phones and Chromium; a click times out on the Linux WebKit runner; not yet diagnosed.      |

## Unproven locally

| Row     | Test                                                                 | Note                                                                                                     |
| ------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| api-053 | `browser/sealing-at-rest.spec.ts` the two Postgres checks (chromium) | Skip without `E2E_POSTGRES_URL`; CI chromium-desktop has Postgres; the full run shows whether they pass. |
