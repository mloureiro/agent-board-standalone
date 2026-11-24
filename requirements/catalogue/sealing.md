# sealing — envelope format and key derivation

Versioned package: the sealed envelope format, blind indexes, key derivation and wrapping, used by CLI, browser
client and the migration tool. The API only shape-checks envelopes. Columns are explained in [../README.md](../README.md).

| ID          | Requirement                                                                                                                                                                              | Sources                   | Today | Test | Test ids |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ----- | ---- | -------- |
| sealing-001 | Sealing is always on; there is no configuration that stores content unsealed.                                                                                                            | R3.6, Q11                 | works | part |          |
| sealing-002 | Envelopes written by today's boards (`abe1.`) and blind indexes (`abh1.`) open and compare with the same data key; golden test vectors taken from today's format pass in every consumer. | R3.7, WEB-075             | works | part |          |
| sealing-003 | Keys for content, transcripts and blind indexes are derived from the data key and the owner name; the derived key id matches the one the server stores.                                  | API-039, CLI-004          | works | part |          |
| sealing-004 | A passphrase and a recovery key each wrap the data key into a slot (1–4 slots); either unwraps it, and changing the passphrase re-wraps without changing the data key.                   | WEB-017, WEB-019, WEB-022 | works | part |          |
| sealing-005 | A third party (any client) using only the sealing package seals and opens exactly as the browser client and CLI do.                                                                      | WEB-075                   | works | part |          |
| sealing-006 | The package produces non-extractable keys in the browser and never exposes the data key or passphrase after unlock.                                                                      | WEB-023                   | works | part |          |
| sealing-007 | Blind indexes are deterministic per owner and differ between owners for the same input.                                                                                                  | API-040, API-036          | works | part |          |
