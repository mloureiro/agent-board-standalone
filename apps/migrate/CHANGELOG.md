# Changelog

## Unreleased

An old server note whose text is not one the API writes is exported with a fixed body instead of its free text, as an `event`, because the board now refuses any other server note.

## 1.0.0

First release. Reads an existing board (hosted Postgres or a local-server PGlite folder of a supported version) and writes a BoardExport file. It offers inspect, export with a dry run, and run, which checks the owner, imports through the API executable and compares the counts. Supports @agent-board/contract ^1.0.0 and @agent-board/sealing ^1.0.0.
