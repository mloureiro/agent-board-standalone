# mobile — Android wrapper

Android wrapper around the browser client (R3.3, Q13). iOS is out. Columns are explained in [../README.md](../README.md).

| ID         | Requirement                                                                                                                        | Sources                  | Today | Test                   | Test ids |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----- | ---------------------- | -------- |
| mobile-001 | The build produces an installable Android APK that bundles the browser client of the same release; it loads no page from a server. | R3.3                     | new   | part                   |          |
| mobile-002 | The app opens one or more servers by address with the same address rule, handshake and per-server isolation as the browser client. | R3.3, R3.5, contract-007 | new   | part                   |          |
| mobile-003 | Sign-in uses the browser hand-off through the system browser (passkeys included); no credential is handled by the wrapper.         | R3.3, APP-069, APP-072   | new   | part                   |          |
| mobile-004 | Links to other origins open in the system browser; dangerous schemes are dropped.                                                  | R3.3, APP-061, APP-062   | new   | part                   |          |
| mobile-005 | A task newly in Needs me raises an Android notification when the app is not in front; tapping it opens that task.                  | R3.3, WEB-068            | new   | part                   |          |
| mobile-006 | The Android back button navigates within the browser client and never loses an unsent draft.                                       | R3.3, P-18               | new   | part                   |          |
| mobile-007 | Installing the APK on the owner's phone and opening the same server as the desktop clients is a written manual walk.               | R3.3, R4.5               | new   | manual: physical phone |          |
