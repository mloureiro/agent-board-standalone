# Rows whose test is still red

Every catalogue row has a test (`e2e` or `part`), is manual, or is retired. The rows below have a test that is still listed in
`e2e/expected-red.json`, so CI skips it on pushes; the six-hourly full run (`E2E_LISTED=run`) runs it and reports when it starts
to pass. Each entry says why it is red and what turns it green. Remove the entry when the row leaves the list.

The 17 rows step 12 left red were fixed on 2026-11-26; only the row below waits on something outside the code.

## Waiting on the first release tags

| Row      | Test                                           | Why red                                                                                                                                                                                      | What turns it green     |
| -------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| repo-003 | `blackbox/matrix-refusal.test.ts` (whole file) | Runs only when the matrix job tests N against N-1 and expects a refusal; no `<part>-v*` release tag exists yet, so there is no N-1 build. Tags are made only after the owner's install walk. | The first release tags. |
