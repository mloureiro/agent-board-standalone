# Rows whose test is still red

Every catalogue row has a test (`e2e` or `part`), is manual, or is retired. The rows below have a test that is still listed in
`e2e/expected-red.json` after step 12, so CI skips it on pushes; the six-hourly full run (`E2E_LISTED=run`) runs it and reports
when it starts to pass. Each entry says why it is red and what turns it green. Remove the entry when the row leaves the list.

## Waiting on a feature that is not built

| Row      | Test                                           | Why red                                                                                                                                   | What turns it green     |
| -------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| repo-003 | `blackbox/matrix-refusal.test.ts` (whole file) | Runs only when the matrix job tests N against N-1 and expects a refusal; no `<part>-v*` release tag exists yet, so there is no N-1 build. | The first release tags. |
