# ADR-0008: Hidden server windows keep a live view

## Status

Accepted.

## Context

A server window that is minimised or behind another app must keep receiving events and raising notifications
(client-app-016). A notification shows the task title, which is sealed and can only be opened by page code holding
the keys; the client app must never store keys natively (client-app-036).

## Decision

- A server window stays loaded while hidden or minimised; it is never unloaded during a run.
- Background throttling is turned off for server windows.
- Fallback when a macOS version still throttles: the native layer polls the attention route for that server and
  raises a generic notification ("A task needs you on <server>"), the same mechanism Android uses.

## Consequences

- Memory grows with the number of open server windows; client-app-009 already limits windows to those opened in
  this run.
- A step-9 spike confirms the throttling switch before the tabs work starts.

## Rows affected

client-app-016, client-app-040 … client-app-043, client-app-050 (new), api-118 (new).
