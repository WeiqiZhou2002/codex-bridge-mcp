# Changelog

## 0.1.1

- Fix: a message sent with `codex_send` while Codex was running could be lost if Codex finished the turn before its next bridge call. Undelivered messages now automatically start a new turn in the same session (or are reported back to Claude if the turn failed or was cancelled).
- Fix: `codex_wait` could return the previous turn's final answer after a follow-up. Starting a new turn now returns any unread output from the previous turn in the `codex_send` result, and `codex_wait` only reports new events.
- Turn results are labelled with their turn number.
- The read cursor is kept on disk only, so several Claude sessions sharing a job stay consistent.
- Tests with a fake `codex` binary: `npm test`.

## 0.1.0

- Initial release.
